import { EventEmitter } from "node:events";
import type { SttEngine, SttResult } from "./engine.js";
import { PcmBuffer } from "./pcm.js";

/** Retains at most one bounded turn to replay once if streaming is unavailable. */
export class FallbackStt extends EventEmitter implements SttEngine {
  private readonly audio = new PcmBuffer();
  private seq?: number;
  private failed = false;
  private generation = 0;
  private readonly partial = (delta: string): void => {
    if (this.seq !== undefined && !this.failed) this.emit("partial", delta);
  };

  public constructor(private readonly primary: SttEngine, private readonly batch: SttEngine,
    private readonly onFallback: () => void = () => undefined) {
    super();
    primary.on("partial", this.partial);
  }
  public prepare(): void | Promise<void> { return this.primary.prepare(); }
  public start(seq: number): void {
    this.seq = seq;
    this.failed = false;
    this.audio.clear();
    try { this.primary.start(seq); } catch { this.failed = true; this.primary.cancel(); }
  }
  public push(pcm: Uint8Array): void {
    this.audio.append(pcm);
    if (!this.failed) {
      try { this.primary.push(pcm); } catch { this.failed = true; this.primary.cancel(); }
    }
  }
  public async end(): Promise<SttResult> {
    const seq = this.seq;
    const generation = this.generation;
    if (seq === undefined) throw new Error("STT turn is inactive");
    try {
      if (!this.failed) {
        try {
          const result = await this.primary.end();
          if (generation !== this.generation) throw new Error("STT turn cancelled");
          return result;
        } catch {
          if (generation === this.generation) this.primary.cancel();
        }
      }
      if (generation !== this.generation) throw new Error("STT turn cancelled");
      this.failed = true;
      this.onFallback();
      this.batch.start(seq);
      this.batch.push(this.audio.bytes());
      this.audio.clear();
      return await this.batch.end();
    } finally {
      if (generation === this.generation) { this.audio.clear(); this.seq = undefined; }
    }
  }
  public cancel(): void {
    this.generation++;
    this.seq = undefined;
    this.audio.clear();
    this.primary.cancel();
    this.batch.cancel();
  }
  public close(): void { this.cancel(); this.primary.off("partial", this.partial); this.primary.close(); this.batch.close(); }
}
