import type { DeviceLink, DeviceMessage, KanaConverter } from "../tts/types.js";
import type { TtsRouter } from "../tts/router.js";
import type { FillerConfig } from "./config.js";

/** The device acknowledges locally; bridge timers never wait for STT final text. */
export class Fillers {
  private timers: ReturnType<typeof setTimeout>[] = [];
  private setup?: AbortController;
  private seq?: number;
  private readonly message = (message?: DeviceMessage) => {
    if (message?.type === "mic.start") this.cancel();
    if (message?.type === "mic.end" && this.config.some(phrase => phrase.kind === "wait")) {
      this.cancel(false);
      const seq = Number(message.seq);
      this.seq = seq;
      this.timers = [8_000, 16_000].map(ms => setTimeout(() => {
        if (this.seq === seq && this.device.online) this.device.send({ type: "fillers.play", seq });
      }, ms));
    }
  };
  private readonly offline = () => { this.setup?.abort(); this.cancel(false); };
  constructor(private readonly device: DeviceLink, private readonly config: FillerConfig,
    private readonly kana: KanaConverter, private readonly router: Pick<TtsRouter, "fillerPcm">,
    private readonly onError: () => void = () => {}) {
    device.on("message", this.message);
    device.on("offline", this.offline);
  }
  async connect(): Promise<void> {
    this.offline();
    const controller = new AbortController();
    this.setup = controller;
    const { signal } = controller;
    try {
      // Disable an older cache immediately; readiness is all-or-nothing on device.
      this.device.send({ type: "fillers.set", phrases: [] });
      if (!this.config.length) return;
      if (this.device.caps.sanotts) {
        const phrases = [];
        for (const phrase of this.config) {
          const kana = await this.kana.convert(phrase.text, signal);
          if (!kana || kana.length > 128) throw new Error("Invalid filler kana");
          phrases.push({ kind: phrase.kind, kana });
        }
        signal.throwIfAborted();
        this.device.send({ type: "fillers.set", phrases });
      } else {
        const audio: Uint8Array[] = [];
        for (const phrase of this.config) {
          const pcm = await this.router.fillerPcm(phrase.text, signal);
          if (pcm.sampleRate !== 16000 || !pcm.data.length || pcm.data.length % 2 || pcm.data.length > 104_856) {
            throw new Error("Filler PCM exceeds cache limit");
          }
          audio.push(pcm.data);
        }
        signal.throwIfAborted();
        this.device.send({ type: "fillers.set", phrases: this.config.map((phrase, index) => ({
          kind: phrase.kind, samples: (audio[index]?.length ?? 0) / 2,
        })) });
        for (const [index, pcm] of audio.entries()) {
          for (let offset = 0; offset < pcm.length; offset += 4092) {
            signal.throwIfAborted();
            this.device.sendBinary(0x03, index, pcm.subarray(offset, offset + 4092));
          }
        }
      }
    } catch {
      if (!signal.aborted) this.onError();
    }
  }
  cancel(send = true): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
    this.seq = undefined;
    if (send && this.device.online) this.device.send({ type: "fillers.cancel" });
  }
  dispose(): void {
    this.offline();
    this.device.off("message", this.message);
    this.device.off("offline", this.offline);
  }
}
