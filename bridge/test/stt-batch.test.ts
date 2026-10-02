import { describe, expect, it, vi } from "vitest";
import { OpenAiBatch } from "../src/stt/openai-batch.js";
import { FakeStt } from "../src/stt/engine.js";
import { FallbackStt } from "../src/stt/fallback.js";
import { createSttEngineFactory } from "../src/stt/factory.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";

const logger = createLogger("error", () => undefined);

describe("batch transcription and fallback", () => {
  it("uploads a WAV with current model/language hints and returns final text", async () => {
    const request = vi.fn<typeof fetch>(async (_url, options) => {
      const form = options?.body as FormData;
      expect(form.get("model")).toBe("gpt-transcribe");
      expect(form.get("languages[]")).toBe("ja");
      expect(form.get("keywords[]")).toBe("スタックちゃん");
      const wav = Buffer.from(await (form.get("file") as Blob).arrayBuffer());
      expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
      expect(wav).toHaveLength(684);
      return new Response(JSON.stringify({ text: "こんにちは、スタックちゃん" }));
    });
    const engine = new OpenAiBatch({ apiKey: "test-only-key", fetch: request });
    engine.start(); engine.push(Buffer.alloc(640));
    await expect(engine.end()).resolves.toEqual({ text: "こんにちは、スタックちゃん", lang: "ja" });
    expect(request).toHaveBeenCalledOnce();
    engine.close();
  });

  it("honors legacy model language syntax and never exposes upstream bodies", async () => {
    const request = vi.fn<typeof fetch>(async (_url, options) => {
      const form = options?.body as FormData;
      expect(form.get("language")).toBe("en");
      expect(form.get("languages[]")).toBeNull();
      return new Response("private transcript", { status: 401 });
    });
    const engine = new OpenAiBatch({ apiKey: "test-only-key", model: "custom-transcriber", language: "en", fetch: request });
    engine.start(); engine.push(Buffer.alloc(640));
    await expect(engine.end()).rejects.toThrow("Batch transcription unavailable");
    engine.close();
  });

  it("aborts a pending upload on cancellation", async () => {
    let signal: AbortSignal | null | undefined;
    const request = vi.fn<typeof fetch>((_url, options) => new Promise((_resolve, reject) => {
      signal = options?.signal;
      signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }));
    const engine = new OpenAiBatch({ apiKey: "test-only-key", fetch: request });
    engine.start(); engine.push(Buffer.alloc(640));
    const result = engine.end(); engine.cancel();
    expect(signal?.aborted).toBe(true);
    await expect(result).rejects.toThrow("Batch transcription unavailable");
    engine.close();
  });

  it("times out uploads and rejects malformed JSON results", async () => {
    const request = vi.fn<typeof fetch>((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
    }));
    const engine = new OpenAiBatch({ apiKey: "test-only-key", fetch: request, timeoutMs: 10 });
    engine.start(); engine.push(Buffer.alloc(640));
    await expect(engine.end()).rejects.toThrow("Batch transcription unavailable");
    engine.close();
    const malformed = new OpenAiBatch({ apiKey: "test-only-key", fetch: async () => new Response('{"text":42}') });
    malformed.start(); malformed.push(Buffer.alloc(640));
    await expect(malformed.end()).rejects.toThrow("Batch transcription unavailable");
    malformed.close();
  });

  it.each(["start", "push", "end"] as const)("replays all PCM exactly once when streaming %s fails", async (method) => {
    const primary = new FakeStt();
    const batch = new FakeStt({ text: "batch", lang: "ja" });
    const partial = vi.fn();
    const push = vi.spyOn(batch, "push");
    const fallback = vi.fn();
    if (method === "end") vi.spyOn(primary, method).mockRejectedValue(new Error("unavailable"));
    else vi.spyOn(primary, method).mockImplementation(() => { throw new Error("unavailable"); });
    const engine = new FallbackStt(primary, batch, fallback);
    engine.on("partial", partial);
    engine.start(7); engine.push(Uint8Array.of(1, 0)); engine.push(Uint8Array.of(2, 0));
    await expect(engine.end()).resolves.toEqual({ text: "batch", lang: "ja" });
    expect(push.mock.calls[0]?.[0]).toEqual(Buffer.from([1, 0, 2, 0]));
    expect(fallback).toHaveBeenCalledOnce();
    primary.emit("partial", "late"); expect(partial).not.toHaveBeenCalled();
    engine.close();
  });

  it("forwards streaming partials and avoids batch requests on success", async () => {
    const primary = new FakeStt(); const batch = new FakeStt();
    const end = vi.spyOn(batch, "end"); const partial = vi.fn();
    const engine = new FallbackStt(primary, batch);
    engine.on("partial", partial); engine.start(1); engine.push(Buffer.alloc(640));
    primary.emit("partial", "こんにちは"); expect(partial).toHaveBeenCalledWith("こんにちは");
    await engine.end(); expect(end).not.toHaveBeenCalled(); engine.close();
  });

  it("does not launch batch after a cancelled streaming result", async () => {
    const primary = new FakeStt(); const batch = new FakeStt(); const start = vi.spyOn(batch, "start");
    let reject: ((error: Error) => void) | undefined;
    vi.spyOn(primary, "end").mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const engine = new FallbackStt(primary, batch);
    engine.start(1); engine.push(Buffer.alloc(640)); const result = engine.end();
    engine.cancel(); reject?.(new Error("cancelled"));
    await expect(result).rejects.toThrow("STT turn cancelled");
    expect(start).not.toHaveBeenCalled(); engine.close();
  });

  it("selects engines and requires an injected API key only for OpenAI modes", () => {
    const config = loadConfig({ DEVICE_PSK: "test-only-key", STT_ENGINE: "fake" });
    expect(createSttEngineFactory(config, logger)()).toBeInstanceOf(FakeStt);
    expect(() => createSttEngineFactory({ ...config, sttEngine: "openai-realtime" }, logger)).toThrow("OPENAI_API_KEY");
    expect(() => createSttEngineFactory({ ...config, sttEngine: "openai-realtime", openaiApiKey: "keychain://OPENAI_API_KEY" }, logger)).toThrow("injected");
    expect(createSttEngineFactory({ ...config, sttEngine: "openai-batch", openaiApiKey: "test-only-key" }, logger)()).toBeInstanceOf(OpenAiBatch);
    const realtime = createSttEngineFactory({ ...config, sttEngine: "openai-realtime", openaiApiKey: "test-only-key" }, logger)();
    expect(realtime).toBeInstanceOf(FallbackStt); realtime.close();
  });
});
