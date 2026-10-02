import { EventEmitter } from "node:events";
import type { Logger } from "../log.js";
import type { SttEngine } from "./engine.js";
import { BYTES_PER_SECOND, MAX_DURATION_MS } from "./pcm.js";

export interface Utterance {
  seq: number;
  text: string;
  lang: string;
  duration_ms: number;
  latency_ms: number;
}
export interface SttSessionOptions {
  logger: Logger;
  logTranscripts?: boolean;
  maxDurationMs?: number;
  idleTimeoutMs?: number;
  resultTimeoutMs?: number;
}
interface Recording {
  seq: number;
  bytes: number;
  ending: boolean;
  durationTimer?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  resultTimer?: NodeJS.Timeout;
}

export class SttSession extends EventEmitter {
  private recording?: Recording;
  private closed = false;
  private readonly partial = (delta: string): void => {
    const recording = this.recording;
    if (recording !== undefined) this.emit("partial", { seq: recording.seq, delta });
  };

  public constructor(private readonly engine: SttEngine, private readonly options: SttSessionOptions) {
    super();
    engine.on("partial", this.partial);
  }
  public prepare(): void { this.engine.prepare(); }
  public start(seq: number): void {
    if (this.closed || this.recording !== undefined) { this.warn("busy"); return; }
    const recording: Recording = { seq, bytes: 0, ending: false };
    this.recording = recording;
    try { this.engine.start(seq); } catch { this.abort("start_failed"); return; }
    recording.durationTimer = setTimeout(() => void this.finish(recording), this.maxDurationMs());
    this.resetIdle(recording);
  }
  public push(seq: number, pcm: Uint8Array): void {
    const recording = this.recording;
    if (recording === undefined || recording.ending) return;
    if (seq !== recording.seq) { this.abort("sequence_mismatch"); return; }
    if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) { this.abort("invalid_pcm"); return; }
    const maxBytes = Math.floor(BYTES_PER_SECOND * this.maxDurationMs() / 1_000 / 2) * 2;
    const bytes = Math.min(pcm.byteLength, maxBytes - recording.bytes);
    try { this.engine.push(pcm.subarray(0, bytes)); } catch { this.abort("push_failed"); return; }
    recording.bytes += bytes;
    if (recording.bytes >= maxBytes) void this.finish(recording);
    else this.resetIdle(recording);
  }
  public end(seq: number): void {
    const recording = this.recording;
    if (recording === undefined || recording.ending) return;
    if (recording.seq !== seq) { this.warn("end_sequence_mismatch"); return; }
    void this.finish(recording);
  }
  public cancel(): void {
    const recording = this.recording;
    this.recording = undefined;
    if (recording !== undefined) this.clearTimers(recording);
    this.engine.cancel();
  }
  public close(): void {
    this.closed = true;
    this.cancel();
    this.engine.off("partial", this.partial);
    this.engine.close();
  }
  private maxDurationMs(): number { return Math.min(this.options.maxDurationMs ?? MAX_DURATION_MS, MAX_DURATION_MS); }
  private resetIdle(recording: Recording): void {
    clearTimeout(recording.idleTimer);
    recording.idleTimer = setTimeout(() => this.abort("idle_timeout"), this.options.idleTimeoutMs ?? 2_000);
  }
  private async finish(recording: Recording): Promise<void> {
    if (this.recording !== recording || recording.ending) return;
    recording.ending = true;
    clearTimeout(recording.durationTimer);
    clearTimeout(recording.idleTimer);
    if (recording.bytes === 0) { this.abort("empty_audio"); return; }
    const endedAt = performance.now();
    recording.resultTimer = setTimeout(() => this.abort("result_timeout"), this.options.resultTimeoutMs ?? 12_000);
    try {
      const result = await this.engine.end();
      if (this.recording !== recording || this.closed) return;
      this.recording = undefined;
      this.clearTimers(recording);
      const utterance: Utterance = {
        seq: recording.seq, text: result.text, lang: result.lang,
        duration_ms: Math.round(recording.bytes / BYTES_PER_SECOND * 1_000),
        latency_ms: Math.max(0, Math.round(performance.now() - endedAt)),
      };
      this.options.logger.info("utterance", {
        seq: utterance.seq, lang: utterance.lang, duration_ms: utterance.duration_ms, latency_ms: utterance.latency_ms,
        characters: utterance.text.length, ...(this.options.logTranscripts === true ? { text: utterance.text } : {}),
      });
      this.emit("utterance", utterance);
    } catch {
      if (this.recording === recording) this.abort("transcription_failed");
    }
  }
  private clearTimers(recording: Recording): void {
    clearTimeout(recording.durationTimer);
    clearTimeout(recording.idleTimer);
    clearTimeout(recording.resultTimer);
  }
  private abort(reason: string): void { this.cancel(); this.warn(reason); }
  private warn(reason: string): void { this.options.logger.warn("stt_rejected", { reason }); }
}
