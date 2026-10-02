import { once } from "node:events";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { createDeviceAuth } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/log.js";
import { createBridgeServer, type BridgeServer } from "../src/server.js";

const psk = "integration-test-key";
const deviceId = "integration-device";
let bridge: BridgeServer | undefined;

afterEach(async () => {
  if (bridge !== undefined) await bridge.close();
  bridge = undefined;
});

async function connect(port: number, key = psk, timestamp = String(Math.floor(Date.now() / 1_000))): Promise<WebSocket> {
  const socket = new WebSocket(`ws://localhost:${port}/device`, {
    headers: {
      "X-Device-Id": deviceId,
      "X-Timestamp": timestamp,
      "X-Auth": createDeviceAuth(key, deviceId, timestamp),
    },
  });
  await once(socket, "open");
  return socket;
}

async function expectHttpRejection(port: number, key: string, timestamp: string): Promise<number | undefined> {
  const socket = new WebSocket(`ws://localhost:${port}/device`, {
    headers: {
      "X-Device-Id": deviceId,
      "X-Timestamp": timestamp,
      "X-Auth": createDeviceAuth(key, deviceId, timestamp),
    },
  });
  socket.on("error", () => undefined);
  const response = (await once(socket, "unexpected-response"))[1];
  response.destroy();
  return response.statusCode;
}

describe("real bridge server", () => {
  it("binds all IPv4 interfaces by default and logs the address without PSK", async () => {
    const config = loadConfig({ DEVICE_PSK: psk });
    const lines: string[] = [];
    bridge = createBridgeServer({
      host: config.host, port: 0, psk: config.devicePsk, logger: createLogger("info", (line) => lines.push(line)),
    });
    const address = await bridge.listen();
    expect(address).toEqual({ host: "0.0.0.0", port: expect.any(Number) });
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      level: "info", event: "bridge_started", host: "0.0.0.0", port: address.port,
    });
    expect(lines.join("\n")).not.toContain(psk);
  });

  it("binds an ephemeral port, welcomes a device, sends face, and survives reconnect", async () => {
    bridge = createBridgeServer({ host: "localhost", port: 0, psk, logger: createLogger("error", () => undefined) });
    const { port } = await bridge.listen();
    expect(port).toBeGreaterThan(0);

    const first = await connect(port);
    first.send(JSON.stringify({ type: "hello", fw: "test", caps: { sanotts: true, servo: true, mic: true } }));
    const welcome = JSON.parse(String((await once(first, "message"))[0]));
    expect(welcome).toMatchObject({ type: "welcome" });

    const faceReceived = once(first, "message");
    expect(bridge.hub.send(deviceId, { type: "face", expression: "happy" })).toBe(true);
    expect(JSON.parse(String((await faceReceived)[0]))).toEqual({ type: "face", expression: "happy" });

    const offline = once(bridge.hub, "offline");
    first.close();
    await offline;
    expect(bridge.hub.getStatus(deviceId).presence).toBe("offline");

    const second = await connect(port, psk, String(Math.floor(Date.now() / 1_000) + 1));
    expect(bridge.hub.getStatus(deviceId).presence).toBe("online");
    second.close();
    await once(second, "close");
  });

  it("returns 401 and logs redacted auth failures for a wrong PSK and stale timestamp", async () => {
    const lines: string[] = [];
    bridge = createBridgeServer({ host: "localhost", port: 0, psk, logger: createLogger("debug", (line) => lines.push(line)) });
    const { port } = await bridge.listen();

    const now = Math.floor(Date.now() / 1_000);
    expect(await expectHttpRejection(port, "wrong-key", String(now))).toBe(401);
    expect(await expectHttpRejection(port, psk, String(now - 61))).toBe(401);
    expect(lines.filter((line) => line.includes("auth_rejected"))).toHaveLength(2);
    expect(lines.join("\n")).not.toContain(deviceId);
  });

  it("serves health checks from the same real server", async () => {
    bridge = createBridgeServer({ host: "localhost", port: 0, psk, logger: createLogger("error", () => undefined) });
    const { port } = await bridge.listen();
    const response = await fetch(`http://localhost:${port}/healthz`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok", devices: 0 });
  });
});
