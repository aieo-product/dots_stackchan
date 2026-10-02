import { EventEmitter } from "node:events";

export interface SttResult {
  text: string;
  lang: string;
}

/** One ordered PCM16/16 kHz/mono turn at a time; partials contain text deltas. */
export interface SttEngine {
  prepare(): void;
  start(seq: number): void;
  push(pcm: Uint8Array): void;
  end(): Promise<SttResult>;
  cancel(): void;
  close(): void;
  on(event: "partial", listener: (delta: string) => void): this;
  off(event: "partial", listener: (delta: string) => void): this;
}

/** Deterministic substitute, not an audio recognizer. */
export class FakeStt extends EventEmitter implements SttEngine {
  private active = false;

  public constructor(private readonly result: SttResult = { text: "こんにちは、スタックちゃん", lang: "ja" }) {
    super();
  }

  public prepare(): void { /* No connection needed. */ }
  public start(seq: number): void { void seq; this.active = true; }
  public push(pcm: Uint8Array): void {
    void pcm;
    if (!this.active) throw new Error("STT turn is inactive");
  }
  public async end(): Promise<SttResult> {
    if (!this.active) throw new Error("STT turn is inactive");
    this.active = false;
    return { ...this.result };
  }
  public cancel(): void { this.active = false; }
  public close(): void { this.cancel(); }
}
