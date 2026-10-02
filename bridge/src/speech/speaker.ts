import { setTimeout as delay } from "node:timers/promises";
import type { VoiceMode } from "./config.js";
import type { PcmSource } from "./openai-tts.js";
import { Pcm24To16 } from "./resampler.js";

export interface Utterance {
  text: string;
  language: string;
  // Japanese reading supplied by the caller; never send kanji to the device G2P.
  kana?: string;
  receivedAt?: number; // performance.now() when the reply text arrives
}
export interface DeviceTransport {
  sendText(message: Readonly<Record<string, unknown>>): Promise<void>;
  sendBinary(frame: Uint8Array): Promise<void>;
  onDone(handler: (seq: number, ok: boolean) => void): () => void;
}
export interface Speaker {
  speak(utterance: Utterance, signal: AbortSignal): Promise<void>;
}
export interface Timing {
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  log(message: string): void;
}
const timing: Timing = {
  now: () => performance.now(),
  sleep: async (ms, signal) => { await delay(ms, undefined, { signal }); },
  log: (message) => console.info(message),
};

export class ProtocolSpeaker implements Speaker {
  private seq = 0;
  constructor(private readonly transport: DeviceTransport,
    private readonly mode: (utterance: Utterance) => VoiceMode,
    private readonly source: PcmSource, private readonly clock: Timing = timing) {}

  async speak(utterance: Utterance, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    utterance = { ...utterance, receivedAt: utterance.receivedAt ?? this.clock.now() };
    const mode = this.mode(utterance);
    if (!utterance.text.trim()) throw new Error("Speech text is empty");
    if (mode === "device" && !utterance.kana?.trim()) throw new Error("Device voice requires kana");
    if (mode === "device" && Buffer.byteLength(utterance.kana ?? "") > 4096) {
      throw new Error("Device kana exceeds 4096 bytes; split the utterance");
    }
    const seq = this.seq++ % 65536;
    // Subscribe before sending: even very short speech can finish immediately.
    let unsubscribe = () => {};
    let rejectDone: (reason: unknown) => void = () => {};
    const local = new AbortController();
    const combined = AbortSignal.any([signal, local.signal]);
    const completed = new Promise<void>((resolve, reject) => {
      rejectDone = reject;
      unsubscribe = this.transport.onDone((doneSeq, ok) => {
        if (doneSeq !== seq) return;
        if (ok) resolve();
        else {
          const error = new Error("Device speech failed");
          local.abort(error);
          reject(error);
        }
      });
    });
    // Completion may reject while the HTTP request or a send is still pending.
    void completed.catch(() => undefined);
    const abort = () => rejectDone(combined.reason);
    combined.addEventListener("abort", abort, { once: true });
    if (combined.aborted) abort();
    const timeout = setTimeout(() => local.abort(new Error("Speech completion timed out")), 120_000 + utterance.text.length * 250);
    let started = false;
    try {
      await this.transport.sendText({ type: "voice.mode", mode });
      combined.throwIfAborted();
      started = true;
      if (mode === "device") {
        await this.transport.sendText({ type: "speak.kana", seq, kana: utterance.kana });
      } else {
        await this.transport.sendText({ type: "tts.start", seq, sample_rate: 16000, channels: 1, bits: 16 });
        await this.stream(utterance, seq, combined);
        combined.throwIfAborted();
        await this.transport.sendText({ type: "tts.end", seq });
      }
      await completed;
    } catch (error) {
      local.abort(error); // also abort the HTTP request/body on device failure
      if (started) await this.transport.sendText({ type: "tts.cancel" }).catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timeout);
      unsubscribe();
      combined.removeEventListener("abort", abort);
    }
  }

  private async stream(utterance: Utterance, seq: number, signal: AbortSignal): Promise<void> {
    const resampler = new Pcm24To16();
    let firstAt: number | undefined;
    let sentSamples = 0;
    let audioUntil = this.clock.now();
    for await (const chunk of this.source(utterance.text, signal)) {
      // Bound work and frames even if fetch returns a large network chunk.
      for (let from = 0; from < chunk.length; from += 6144) {
        signal.throwIfAborted();
        const pcm = resampler.push(chunk.subarray(from, from + 6144));
        for (let offset = 0; offset < pcm.length; offset += 4092) {
          signal.throwIfAborted();
          // Keep at most ~500 ms ahead of playback so fast synthesis cannot
          // overflow the device's two-second ring. No wait before first audio.
          if (firstAt !== undefined) {
            const wait = audioUntil - 500 - this.clock.now();
            if (wait > 0) await this.clock.sleep(wait, signal);
          }
          signal.throwIfAborted();
          const payload = pcm.subarray(offset, offset + 4092);
          const frame = Buffer.alloc(3 + payload.length);
          frame[0] = 0x02;
          frame.writeUInt16LE(seq, 1);
          payload.copy(frame, 3);
          await this.transport.sendBinary(frame);
          if (firstAt === undefined) {
            firstAt = this.clock.now();
            const ms = firstAt - (utterance.receivedAt ?? firstAt);
            this.clock.log(`[tts] first_audio_ms=${ms.toFixed(1)} target_ms=800 met=${ms <= 800}`);
          }
          sentSamples += payload.length / 2;
          audioUntil = Math.max(audioUntil, this.clock.now()) + payload.length / 32;
        }
      }
    }
    resampler.finish();
    if (!sentSamples) throw new Error("OpenAI TTS returned no audio");
  }
}
