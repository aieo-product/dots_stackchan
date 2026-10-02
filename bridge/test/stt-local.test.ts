import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalSttEngine, type LocalSttBackend } from "../src/stt/local.js";
import { MlxWhisperBackend } from "../src/stt/mlx-whisper.js";
import { WhisperCppBackend } from "../src/stt/whisper-cpp.js";

const engines: LocalSttEngine[] = [];
const backends: MlxWhisperBackend[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const engine of engines.splice(0)) engine.close();
  for (const backend of backends.splice(0)) backend.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
function fakeBackend(): LocalSttBackend {
  return { prepare: vi.fn().mockResolvedValue(undefined), transcribe: vi.fn().mockResolvedValue("こんにちは、スタックちゃん"), close: vi.fn() };
}
function engineFor(backend: LocalSttBackend, timeoutMs = 10_000) {
  const engine = new LocalSttEngine(backend, "ja", timeoutMs); engines.push(engine); return engine;
}
function worker(delayMs = 0, options: { invalid?: boolean; ready?: boolean } = {}) {
  let launches = 0;
  const backend = new MlxWhisperBackend({ model: "test-model", prepareTimeoutMs: options.ready === false ? 150 : 2_000, launch: () => {
    launches++;
    return spawn(process.execPath, ["--input-type=module", "-e", `
      import { createInterface } from 'node:readline';
      ${options.ready === false ? "" : "console.log(JSON.stringify({ready:true}));"}
      createInterface({input:process.stdin}).on('line', line => {
        const {id} = JSON.parse(line);
        setTimeout(() => console.log(${options.invalid ? "'invalid JSON'" : "JSON.stringify({id,text:'こんにちは、スタックちゃん'})"}), ${delayMs});
      });
    `], { stdio: "pipe" });
  } });
  backends.push(backend);
  return { backend, get launches() { return launches; } };
}

describe("LocalSttEngine", () => {
  it("batches only at end, bounds PCM, and reuses its prepared backend", async () => {
    const backend = fakeBackend(); const engine = engineFor(backend);
    await engine.prepare();
    for (let turn = 0; turn < 2; turn++) {
      engine.start(); engine.push(Buffer.alloc(640)); engine.push(Buffer.alloc(640));
      expect(backend.transcribe).toHaveBeenCalledTimes(turn);
      await expect(engine.end()).resolves.toEqual({ text: "こんにちは、スタックちゃん", lang: "ja" });
    }
    expect(backend.prepare).toHaveBeenCalledOnce();
    expect(vi.mocked(backend.transcribe).mock.calls[0][0]).toHaveLength(1280);
    engine.start(); expect(() => engine.push(Buffer.alloc(480_002))).toThrow("oversized");
  });
  it("redacts backend failure details and respects timeout/cancellation", async () => {
    const backend = fakeBackend();
    vi.mocked(backend.transcribe).mockImplementation((_pcm, _language, signal) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("private backend details")), { once: true });
    }));
    const engine = engineFor(backend, 30);
    engine.start(); engine.push(Buffer.alloc(640));
    await expect(engine.end()).rejects.toThrow(/^Local transcription unavailable$/);
    engine.start(); engine.push(Buffer.alloc(640)); const result = engine.end();
    const rejection = expect(result).rejects.toThrow(/^Local transcription unavailable$/);
    engine.cancel(); await rejection;
    engine.close(); expect(backend.close).toHaveBeenCalled();
    expect(() => engine.start()).toThrow("unavailable");
  });
});

describe("persistent MLX pipe adapter", () => {
  it("waits for readiness and keeps one process across utterances", async () => {
    const fixture = worker(); const engine = engineFor(fixture.backend);
    await engine.prepare();
    for (let turn = 0; turn < 2; turn++) {
      engine.start(); engine.push(Buffer.alloc(640));
      await expect(engine.end()).resolves.toMatchObject({ text: "こんにちは、スタックちゃん" });
    }
    expect(fixture.launches).toBe(1);
  });
  it("discards cancelled replies without restarting the resident model", async () => {
    const { backend } = worker(60); await backend.prepare();
    const controller = new AbortController();
    const result = backend.transcribe(Buffer.alloc(640), "ja", controller.signal);
    // Allow the request to reach the pipe before aborting.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const rejection = expect(result).rejects.toThrow("cancelled"); controller.abort(); await rejection;
    await expect(backend.transcribe(Buffer.alloc(640), "ja", new AbortController().signal)).rejects.toThrow("busy");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(backend.transcribe(Buffer.alloc(640), "ja", new AbortController().signal)).resolves.toContain("スタックちゃん");
  });
  it("rejects malformed replies safely", async () => {
    const { backend } = worker(0, { invalid: true }); await backend.prepare();
    await expect(backend.transcribe(Buffer.alloc(640), "ja", new AbortController().signal)).rejects.toThrow(/^Local transcription unavailable$/);
  });
  it("cancels a turn while the model loads without accumulating queued audio", async () => {
    const { backend } = worker(0, { ready: false });
    const controller = new AbortController();
    const result = backend.transcribe(Buffer.alloc(640), "ja", controller.signal);
    const rejection = expect(result).rejects.toThrow("cancelled");
    controller.abort(); await rejection;
  });
  it("bounds preparation time and shuts down a worker before readiness", async () => {
    const { backend } = worker(0, { ready: false });
    await expect(backend.prepare()).rejects.toThrow("unavailable");
    const again = backend.prepare(); const rejection = expect(again).rejects.toThrow("unavailable");
    backend.close(); await rejection;
  });
});

describe("whisper-server HTTP adapter", () => {
  it("checks a loaded model once and uploads an in-memory WAV per turn", async () => {
    const requests: Array<{ url?: string; body: Buffer }> = [];
    const server = createServer(async (request, response) => {
      const parts: Buffer[] = [];
      for await (const chunk of request) parts.push(Buffer.from(chunk as Uint8Array));
      requests.push({ url: request.url, body: Buffer.concat(parts) });
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(request.url === "/health" ? { status: "ok" } : { text: "こんにちは、スタックちゃん" }));
    });
    servers.push(server); server.listen(0, "localhost"); await once(server, "listening");
    const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing test port");
    const engine = engineFor(new WhisperCppBackend({ url: `http://localhost:${address.port}/inference` }));
    await engine.prepare();
    for (let turn = 0; turn < 2; turn++) {
      engine.start(); engine.push(Buffer.alloc(640)); await engine.end();
    }
    expect(requests.map((r) => r.url)).toEqual(["/health", "/inference", "/inference"]);
    expect(requests[1].body.includes(Buffer.from("RIFF"))).toBe(true);
    expect(requests[1].body.toString()).toContain('name="language"\r\n\r\nja');
  });
  it.each(["failure", "invalid", "oversize"])("rejects %s responses without exposing their bodies", async (mode) => {
    const backend = new WhisperCppBackend({ url: "http://localhost:8080/inference", fetch: vi.fn()
      .mockResolvedValueOnce(Response.json({ status: "ok" }))
      .mockResolvedValueOnce(mode === "failure" ? new Response("private details", { status: 500 })
        : mode === "oversize" ? new Response("x".repeat(65_537)) : Response.json({ unexpected: true })) });
    const engine = engineFor(backend); engine.start(); engine.push(Buffer.alloc(640));
    await expect(engine.end()).rejects.toThrow(/^Local transcription unavailable$/);
  });
});
