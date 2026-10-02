import { execFile } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createDeviceAuth } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import type { HubEvent } from "../src/device-hub.js";
import { createLogger } from "../src/log.js";
import { BinaryKind, encodeBinaryFrame } from "../src/protocol.js";
import { createBridgeServer, type BridgeServer } from "../src/server.js";
import { createSttEngineFactory } from "../src/stt/factory.js";
import type { Utterance } from "../src/stt/session.js";

const run = promisify(execFile);
const psk = "test-only-key";
const deviceId = "local-test-device";
let bridge: BridgeServer | undefined;
let server: Server | undefined;
afterEach(async () => {
  await bridge?.close(); bridge = undefined;
  if (server !== undefined) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});
async function start(url: string) {
  // Intentionally exclude OPENAI_API_KEY even when the parent has one.
  const config = loadConfig({ DEVICE_PSK: psk, STT_ENGINE: "local", STT_LOCAL_BACKEND: "whisper-cpp", STT_LOCAL_URL: url });
  const lines: string[] = [];
  const logger = createLogger("debug", (line) => lines.push(line));
  bridge = createBridgeServer({ host: "localhost", port: 0, psk, logger,
    stt: { createEngine: createSttEngineFactory(config, logger) } });
  const { port } = await bridge.listen();
  return { port, hub: bridge.hub, lines };
}

// Character error rate: punctuation/space normalized; insertions can exceed 100%.
function cer(reference: string, hypothesis: string): number {
  const normalize = (text: string) => [...text.normalize("NFKC").replace(/[\p{P}\p{Z}\s]/gu, "")];
  const expected = normalize(reference); const actual = normalize(hypothesis);
  let row = expected.map((_, index) => index + 1); row.unshift(0);
  for (let j = 0; j < actual.length; j++) {
    const next = [j + 1];
    for (let i = 0; i < expected.length; i++) {
      next.push(Math.min(next[i] + 1, row[i + 1] + 1, row[i] + (expected[i] === actual[j] ? 0 : 1)));
    }
    row = next;
  }
  return Math.round(row[expected.length] / expected.length * 100);
}

describe("keyless local bridge", () => {
  it("starts with STT_ENGINE=local and delivers a CLI WAV utterance through a fake whisper-server", async () => {
    let inferences = 0;
    server = createServer(async (request, response) => {
      for await (const chunk of request) void chunk;
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/inference") inferences++;
      response.end(JSON.stringify(request.url === "/health" ? { status: "ok" } : { text: "こんにちは、スタックちゃん" }));
    });
    server.listen(0, "localhost"); await once(server, "listening");
    const address = server.address(); if (address === null || typeof address === "string") throw new Error("Missing test port");
    const { port, hub, lines } = await start(`http://localhost:${address.port}/inference`);
    const result = once(hub, "utterance", { signal: AbortSignal.timeout(5_000) });
    await run(process.execPath, ["scripts/ws-client.mjs", "--id", deviceId, "--url", `ws://localhost:${port}/device`,
      "--wav", "bridge/test/fixtures/hello_ja.wav", "--wait-ms", "100"], { env: { DEVICE_PSK: psk } });
    const [event] = await result as [HubEvent<Utterance>];
    expect(event.payload).toMatchObject({ text: "こんにちは、スタックちゃん", lang: "ja", duration_ms: 1_830 });
    expect(inferences).toBe(1);
    expect(lines.join("\n")).not.toContain("こんにちは");
  }, 10_000);
});

// An already running resident server; no downloads or paid API calls in CI.
describe.skipIf(!process.env.STT_LOCAL_TEST_URL)("measured local synthetic-speech integration", () => {
  it("reports end-to-text latency and accuracy for three paced WAV turns", async () => {
    const { port, hub } = await start(process.env.STT_LOCAL_TEST_URL ?? "http://localhost:8080/inference");
    const ready = once(hub, "stt.ready", { signal: AbortSignal.timeout(5_000) });
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const socket = new WebSocket(`ws://localhost:${port}/device`, { headers: {
      "X-Device-Id": deviceId, "X-Timestamp": timestamp, "X-Auth": createDeviceAuth(psk, deviceId, timestamp),
    } });
    await once(socket, "open"); await ready;
    const send = (event: Record<string, unknown>) => socket.send(JSON.stringify(event));
    const pcm = readFileSync(new URL("./fixtures/hello_ja.wav", import.meta.url)).subarray(44);
    const timings: Array<Record<string, unknown>> = [];
    for (let seq = 1; seq <= 3; seq++) {
      const result = once(hub, "utterance", { signal: AbortSignal.timeout(15_000) });
      send({ type: "mic.start", seq, sample_rate: 16000 });
      for (let offset = 0; offset < pcm.length; offset += 640) {
        const chunk = pcm.subarray(offset, offset + 640);
        socket.send(encodeBinaryFrame(BinaryKind.microphonePcm, seq, chunk));
        await delay(chunk.length / 32);
      }
      send({ type: "mic.end", seq, reason: "release" });
      const [event] = await result as [HubEvent<Utterance>];
      const timing = { engine: "local/whisper-cpp", turn: seq, duration_ms: event.payload.duration_ms,
        latency_ms: event.payload.latency_ms, accuracy_keyword: event.payload.text.includes("スタックちゃん"),
        cer_percent: cer("こんにちは、スタックちゃん", event.payload.text), latency_target_met: event.payload.latency_ms <= 600 };
      timings.push(timing); console.info(JSON.stringify(timing));
      expect(event.payload.text.trim().length).toBeGreaterThan(0);
    }
    console.table(timings); socket.close();
  }, 60_000);
});
