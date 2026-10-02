import { EventEmitter } from "node:events";
import { abortable } from "./abortable.js";
import type { SttEngine, SttResult } from "./engine.js";
import { PcmBuffer } from "./pcm.js";

/** Backends retain their model between calls; recognition begins only at mic.end. */
export interface LocalSttBackend {
  prepare(): Promise<void>;
  transcribe(pcm: Uint8Array, language: string, signal: AbortSignal): Promise<string>;
  close(): void;
}

export const DEFAULT_LOCAL_MODEL = "mlx-community/whisper-turbo";

export class LocalSttEngine extends EventEmitter implements SttEngine {
  private readonly audio = new PcmBuffer();
  private active = false;
  private closed = false;
  private controller?: AbortController;

  public constructor(private readonly backend: LocalSttBackend, private readonly language = "ja",
    private readonly timeoutMs = 10_000) { super(); }
  public prepare(): Promise<void> { return this.backend.prepare(); }
  public start(): void {
    if (this.closed || this.active || this.controller !== undefined) throw new Error("Local STT turn is unavailable");
    this.active = true;
  }
  public push(pcm: Uint8Array): void {
    if (!this.active) throw new Error("STT turn is inactive");
    this.audio.append(pcm);
  }
  public async end(): Promise<SttResult> {
    if (!this.active) throw new Error("STT turn is inactive");
    this.active = false;
    const pcm = this.audio.bytes();
    this.audio.clear();
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const text = await abortable(this.backend.transcribe(pcm, this.language, controller.signal), controller.signal);
      if (controller.signal.aborted) throw new Error("Cancelled");
      return { text, lang: this.language };
    } catch {
      throw new Error("Local transcription unavailable");
    } finally {
      clearTimeout(timer);
      if (this.controller === controller) this.controller = undefined;
    }
  }
  public cancel(): void {
    this.active = false;
    this.audio.clear();
    this.controller?.abort();
    this.controller = undefined;
  }
  public close(): void { this.closed = true; this.cancel(); this.backend.close(); }
}
