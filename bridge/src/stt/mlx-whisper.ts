import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { abortable } from "./abortable.js";
import type { LocalSttBackend } from "./local.js";

export interface MlxWhisperOptions {
  model: string;
  python?: string;
  prepareTimeoutMs?: number;
  /** Dependency injection for pipe/lifecycle tests; production always runs the bundled worker. */
  launch?: () => ChildProcessWithoutNullStreams;
}
interface Pending {
  id: number;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
}

/** One Python process per device, one resident model, no per-utterance cold start. */
export class MlxWhisperBackend implements LocalSttBackend {
  private child?: ChildProcessWithoutNullStreams;
  private preparation?: Promise<void>;
  private resolvePreparation?: () => void;
  private rejectPreparation?: (error: Error) => void;
  private timer?: NodeJS.Timeout;
  private pending?: Pending;
  private nextId = 0;
  private output = "";
  private closed = false;

  public constructor(private readonly options: MlxWhisperOptions) {}
  public prepare(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Local STT is closed"));
    if (this.preparation !== undefined) return this.preparation;
    const preparation = new Promise<void>((resolve, reject) => {
      this.resolvePreparation = resolve;
      this.rejectPreparation = reject;
    });
    this.preparation = preparation;
    void preparation.catch(() => undefined);
    this.timer = setTimeout(() => this.fail(), this.options.prepareTimeoutMs ?? 120_000);
    try {
      const child = this.options.launch?.() ?? spawn(this.options.python ?? "python3", ["-u",
        fileURLToPath(new URL("./mlx-worker.py", import.meta.url)), "--model", this.options.model],
      { stdio: "pipe" });
      this.child = child;
      child.on("error", () => { if (this.child === child) this.fail(); });
      child.on("exit", () => { if (this.child === child) this.fail(); });
      child.stdin.on("error", () => { if (this.child === child) this.fail(); });
      // Do not forward library logs, paths, or transcripts to the bridge logger.
      child.stderr.resume();
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (this.child !== child) return;
        this.output += chunk;
        if (Buffer.byteLength(this.output) > 64 * 1_024) { this.fail(); return; }
        let newline: number;
        while ((newline = this.output.indexOf("\n")) !== -1) {
          const line = this.output.slice(0, newline);
          this.output = this.output.slice(newline + 1);
          try { this.handle(JSON.parse(line)); } catch { this.fail(); return; }
        }
      });
    } catch { this.fail(); }
    return preparation;
  }
  private handle(result: unknown): void {
    if (result === null || typeof result !== "object") { this.fail(); return; }
    if ("ready" in result && result.ready === true) {
      clearTimeout(this.timer);
      this.resolvePreparation?.();
      this.resolvePreparation = undefined;
      this.rejectPreparation = undefined;
      return;
    }
    const pending = this.pending;
    if (pending === undefined) { this.fail(); return; }
    if (!("id" in result) || result.id !== pending.id) { this.fail(); return; }
    this.pending = undefined;
    pending.cleanup();
    if ("text" in result && typeof result.text === "string") pending.resolve(result.text);
    else pending.reject(new Error("Local transcription unavailable"));
  }
  public async transcribe(pcm: Uint8Array, language: string, signal: AbortSignal): Promise<string> {
    await abortable(this.prepare(), signal);
    signal.throwIfAborted();
    if (this.pending !== undefined || this.child === undefined) throw new Error("Local STT worker is busy");
    return new Promise<string>((resolve, reject) => {
      // Cancellation suppresses the result but lets the resident model finish its
      // current inference. No additional turn is queued while it is still busy.
      const aborted = (): void => reject(new Error("Local transcription cancelled"));
      const id = ++this.nextId;
      this.pending = { id, resolve, reject, cleanup: () => signal.removeEventListener("abort", aborted) };
      signal.addEventListener("abort", aborted, { once: true });
      this.child?.stdin.write(`${JSON.stringify({ id, language, pcm: Buffer.from(pcm).toString("base64") })}\n`);
    });
  }
  private fail(): void {
    clearTimeout(this.timer);
    const error = new Error("Local transcription unavailable");
    this.rejectPreparation?.(error);
    this.pending?.cleanup();
    this.pending?.reject(error);
    const child = this.child;
    this.child = undefined;
    this.preparation = undefined;
    this.resolvePreparation = undefined;
    this.rejectPreparation = undefined;
    this.pending = undefined;
    this.output = "";
    child?.kill();
  }
  public close(): void { this.closed = true; this.fail(); }
}
