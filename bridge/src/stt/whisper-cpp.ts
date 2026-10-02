import { abortable } from "./abortable.js";
import type { LocalSttBackend } from "./local.js";
import { pcmToWav } from "./pcm.js";

export interface WhisperCppOptions {
  /** Full whisper-server inference URL; the server selects/loads the model at startup. */
  url: string;
  fetch?: typeof fetch;
}

async function json(response: Response): Promise<unknown> {
  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    throw new Error("Local STT request failed");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 64 * 1_024) throw new Error("Local STT response too large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString()) as unknown;
  } finally { await reader.cancel(); }
}

/** Uses an already running whisper-server: no /load or per-turn process launch. */
export class WhisperCppBackend implements LocalSttBackend {
  private preparation?: Promise<void>;
  private readonly controller = new AbortController();
  public constructor(private readonly options: WhisperCppOptions) {}
  public prepare(): Promise<void> {
    this.preparation ??= this.checkHealth().catch(() => {
      this.preparation = undefined;
      throw new Error("Local STT server unavailable");
    });
    return this.preparation;
  }
  private async checkHealth(): Promise<void> {
    const response = await (this.options.fetch ?? fetch)(new URL("health", this.options.url), {
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(5_000)]),
    });
    const result = await json(response);
    if (result === null || typeof result !== "object" || !("status" in result) || result.status !== "ok") {
      throw new Error("Local STT model is not ready");
    }
  }
  public async transcribe(pcm: Uint8Array, language: string, signal: AbortSignal): Promise<string> {
    await abortable(this.prepare(), signal);
    signal.throwIfAborted();
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(pcmToWav(pcm))], { type: "audio/wav" }), "audio.wav");
    form.set("language", language);
    form.set("response_format", "json");
    form.set("temperature", "0");
    form.set("prompt", "スタックちゃん");
    const response = await (this.options.fetch ?? fetch)(this.options.url, {
      method: "POST", body: form, signal: AbortSignal.any([signal, this.controller.signal]),
    });
    const result = await json(response);
    if (result === null || typeof result !== "object" || !("text" in result) || typeof result.text !== "string") {
      throw new Error("Invalid local STT result");
    }
    return result.text.trim();
  }
  public close(): void { this.controller.abort(); }
}
