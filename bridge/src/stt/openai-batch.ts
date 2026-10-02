import { EventEmitter } from "node:events";
import type { SttEngine, SttResult } from "./engine.js";
import { PcmBuffer, pcmToWav } from "./pcm.js";

export const DEFAULT_BATCH_MODEL = "gpt-transcribe";
export interface OpenAiBatchOptions {
  apiKey: string;
  model?: string;
  language?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class OpenAiBatch extends EventEmitter implements SttEngine {
  private readonly audio = new PcmBuffer();
  private controller?: AbortController;
  private active = false;

  public constructor(private readonly options: OpenAiBatchOptions) { super(); }
  public prepare(): void { /* Requests start only after mic.end. */ }
  public start(): void { this.cancel(); this.active = true; }
  public push(pcm: Uint8Array): void {
    if (!this.active) throw new Error("STT turn is inactive");
    this.audio.append(pcm);
  }
  public async end(): Promise<SttResult> {
    if (!this.active) throw new Error("STT turn is inactive");
    this.active = false;
    const wav = pcmToWav(this.audio.bytes());
    this.audio.clear();
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 8_000);
    try {
      const model = this.options.model ?? DEFAULT_BATCH_MODEL;
      const lang = this.options.language ?? "ja";
      const form = new FormData();
      form.set("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
      form.set("model", model);
      form.set("response_format", "json");
      if (model.startsWith("gpt-transcribe")) {
        form.set("languages[]", lang);
        form.set("keywords[]", "スタックちゃん");
      } else {
        form.set("language", lang);
        form.set("prompt", "スタックちゃん");
      }
      const response = await (this.options.fetch ?? fetch)("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST", headers: { Authorization: `Bearer ${this.options.apiKey}` }, body: form,
        signal: controller.signal,
      });
      // Never include an upstream body, transcript, or credential in errors/logs.
      if (!response.ok) throw new Error("Batch transcription request failed");
      const result: unknown = await response.json();
      if (controller.signal.aborted) throw new Error("Batch transcription cancelled");
      if (result === null || typeof result !== "object" || !("text" in result) || typeof result.text !== "string") {
        throw new Error("Invalid batch transcription response");
      }
      return { text: result.text, lang };
    } catch {
      throw new Error("Batch transcription unavailable");
    } finally {
      clearTimeout(timer);
      if (this.controller === controller) this.controller = undefined;
    }
  }
  public cancel(): void { this.active = false; this.audio.clear(); this.controller?.abort(); this.controller = undefined; }
  public close(): void { this.cancel(); }
}
