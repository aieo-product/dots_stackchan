import { execFile } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeviceAuth } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import type { HubEvent } from "../src/device-hub.js";
import { createLogger } from "../src/log.js";
import { BinaryKind, encodeBinaryFrame } from "../src/protocol.js";
import { createBridgeServer, type BridgeServer } from "../src/server.js";
import { FakeStt } from "../src/stt/engine.js";
import { createSttEngineFactory } from "../src/stt/factory.js";
import type { Utterance } from "../src/stt/session.js";

const run = promisify(execFile);
const psk = "test-only-key";
const deviceId = "stt-test-device";
let bridge: BridgeServer | undefined;
afterEach(async () => { await bridge?.close(); bridge = undefined; });

async function connect(port: number, timestamp = String(Math.floor(Date.now() / 1_000))): Promise<WebSocket> {
  const socket = new WebSocket(`ws://localhost:${port}/device`, { headers: {
    "X-Device-Id": deviceId, "X-Timestamp": timestamp, "X-Auth": createDeviceAuth(psk, deviceId, timestamp),
  } });
  await once(socket, "open"); return socket;
}
function send(socket: WebSocket, event: Record<string, unknown>): void { socket.send(JSON.stringify(event)); }

async function startFake() {
  const lines: string[] = [];
  const engines: FakeStt[] = [];
  bridge = createBridgeServer({ host: "localhost", port: 0, psk, logger: createLogger("debug", (line) => lines.push(line)),
    stt: { createEngine: () => { const engine = new FakeStt(); engines.push(engine); return engine; } },
  });
  const { port } = await bridge.listen();
  return { port, lines, engines, hub: bridge.hub };
}

describe("DeviceHub STT wiring", () => {
  it("replays synthetic WAV through the actual CLI and authenticated WebSocket", async () => {
    const { port, hub, lines } = await startFake();
    const result = once(hub, "utterance");
    const output = await run(process.execPath, ["scripts/ws-client.mjs", "--id", deviceId,
      "--url", `ws://localhost:${port}/device`, "--wav", "bridge/test/fixtures/hello_ja.wav", "--wait-ms", "100"],
    { env: { ...process.env, DEVICE_PSK: psk } });
    const [event] = await result as [HubEvent<Utterance>];
    expect(event).toMatchObject({ deviceId, payload: { seq: 1, text: "こんにちは、スタックちゃん", lang: "ja", duration_ms: 1_830 } });
    expect(output.stdout).toContain('"frames":92');
    expect(output.stdout).toContain('"bytes":58550');
    expect(lines.join("\n")).not.toContain("こんにちは");
    expect(lines.filter((line) => line.includes('"event":"utterance"'))).toHaveLength(1);
  }, 10_000);

  it("rejects incompatible WAV input before opening a connection", async () => {
    await expect(run(process.execPath, ["scripts/ws-client.mjs", "--id", deviceId, "--wav", "package.json"],
      { env: { ...process.env, DEVICE_PSK: psk } })).rejects.toMatchObject({ code: 2, stderr: expect.stringContaining("WAV input rejected") });
  });

  it("isolates devices and disposes sessions on reconnect and shutdown", async () => {
    const { port, hub, engines } = await startFake();
    const first = await connect(port); const firstClose = vi.spyOn(engines[0], "close");
    send(first, { type: "mic.start", seq: 1, sample_rate: 16000 });
    first.send(encodeBinaryFrame(BinaryKind.microphonePcm, 1, Buffer.alloc(640)));
    const replacement = await connect(port, String(Math.floor(Date.now() / 1_000) + 1));
    await vi.waitFor(() => expect(firstClose).toHaveBeenCalledOnce());
    const utterance = vi.fn(); hub.on("utterance", utterance);
    send(replacement, { type: "mic.end", seq: 1, reason: "release" });
    const result = once(hub, "utterance");
    send(replacement, { type: "mic.start", seq: 2, sample_rate: 16000 });
    replacement.send(encodeBinaryFrame(BinaryKind.microphonePcm, 2, Buffer.alloc(640)));
    send(replacement, { type: "mic.end", seq: 2, reason: "release" });
    await result; expect(utterance).toHaveBeenCalledOnce();
    const secondClose = vi.spyOn(engines[1], "close");
    await bridge?.close(); bridge = undefined;
    expect(secondClose).toHaveBeenCalledOnce();
  });

  it("blocks mic.start when a device reports playback", async () => {
    const { port, hub, engines, lines } = await startFake(); const socket = await connect(port);
    const start = vi.spyOn(engines[0], "start");
    send(socket, { type: "state", state: "speaking" });
    send(socket, { type: "mic.start", seq: 1, sample_rate: 16000 });
    const ready = once(hub, "state"); send(socket, { type: "state", state: "idle" }); await ready;
    expect(start).not.toHaveBeenCalled(); expect(lines.join("\n")).toContain("device_playing");
    socket.close(); await once(socket, "close");
  });

  it("does not mix concurrent devices' microphone turns", async () => {
    const { port, hub } = await startFake(); const first = await connect(port);
    const secondId = "second-test-device"; const timestamp = String(Math.floor(Date.now() / 1_000));
    const second = new WebSocket(`ws://localhost:${port}/device`, { headers: {
      "X-Device-Id": secondId, "X-Timestamp": timestamp, "X-Auth": createDeviceAuth(psk, secondId, timestamp),
    } });
    await once(second, "open");
    const events: Array<HubEvent<Utterance>> = []; hub.on("utterance", (event: HubEvent<Utterance>) => events.push(event));
    for (const socket of [first, second]) {
      send(socket, { type: "mic.start", seq: 1, sample_rate: 16000 });
      socket.send(encodeBinaryFrame(BinaryKind.microphonePcm, 1, Buffer.alloc(socket === first ? 640 : 1280)));
      send(socket, { type: "mic.end", seq: 1, reason: "release" });
    }
    await vi.waitFor(() => expect(events).toHaveLength(2));
    expect(events.map((event) => [event.deviceId, event.payload.duration_ms])).toEqual([[deviceId, 20], [secondId, 40]]);
    first.close(); second.close();
  });
});

// Opt-in by key injection; CI intentionally has no API key. No audio/transcript logging.
describe.skipIf(!process.env.OPENAI_API_KEY)("real OpenAI synthetic-speech integration", () => {
  it.each(["openai-realtime", "openai-batch"] as const)("recognizes スタックちゃん using %s", async (sttEngine) => {
    const logger = createLogger("error", () => undefined);
    const config = loadConfig({ ...process.env, DEVICE_PSK: psk, STT_ENGINE: sttEngine });
    bridge = createBridgeServer({ host: "localhost", port: 0, psk, logger, stt: { createEngine: createSttEngineFactory(config, logger) } });
    const { port } = await bridge.listen(); const result = once(bridge.hub, "utterance");
    const output = run(process.execPath, ["scripts/ws-client.mjs", "--id", deviceId, "--url", `ws://localhost:${port}/device`,
      "--wav", "bridge/test/fixtures/hello_ja.wav", "--wait-ms", "12000"], { env: { ...process.env, DEVICE_PSK: psk } });
    // Race against replay completion so a failed provider cannot hang the test indefinitely.
    const event = await Promise.race([result.then(([event]) => event as HubEvent<Utterance>), output.then(() => { throw new Error("No utterance received"); })]);
    expect(event.payload.text).toContain("スタックちゃん");
    expect(event.payload.duration_ms).toBe(Math.round((readFileSync(new URL("./fixtures/hello_ja.wav", import.meta.url)).length - 44) / 32));
    console.info(JSON.stringify({ engine: sttEngine, duration_ms: event.payload.duration_ms, latency_ms: event.payload.latency_ms,
      latency_target_met: event.payload.latency_ms <= 600 }));
    await output;
  }, 25_000);
});
