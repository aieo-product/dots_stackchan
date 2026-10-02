import { EventEmitter, once } from "node:events";
import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";

import { DeviceHub } from "../src/device-hub.js";
import type { Logger } from "../src/log.js";
import { BinaryKind, encodeBinaryFrame } from "../src/protocol.js";

class FakeSocket extends EventEmitter {
  public readyState: number = WebSocket.OPEN;
  public readonly OPEN = WebSocket.OPEN;
  public readonly send = vi.fn();
  public readonly close = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
    this.emit("close");
  });
  public readonly terminate = vi.fn(() => this.emit("close"));
  public readonly ping = vi.fn();
}

const logger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function asWebSocket(socket: FakeSocket): WebSocket {
  return socket as unknown as WebSocket;
}

describe("DeviceHub", () => {
  it("sends a typed command to an online device", () => {
    const hub = new DeviceHub(logger);
    const socket = new FakeSocket();
    hub.connect("device", asWebSocket(socket), "session");

    expect(hub.send("device", { type: "face", expression: "happy" })).toBe(true);
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "face", expression: "happy" }));
  });

  it("moves offline then online across disconnect and reconnect", async () => {
    const hub = new DeviceHub(logger);
    const first = new FakeSocket();
    hub.connect("device", asWebSocket(first), "first");
    const offline = once(hub, "offline");
    first.close();
    await offline;
    expect(hub.getStatus("device").presence).toBe("offline");

    const online = once(hub, "online");
    hub.connect("device", asWebSocket(new FakeSocket()), "second");
    await online;
    expect(hub.getStatus("device").presence).toBe("online");
  });

  it("responds to hello and emits device events", async () => {
    const hub = new DeviceHub(logger);
    const socket = new FakeSocket();
    hub.connect("device", asWebSocket(socket), "session");
    const eventReceived = once(hub, "button");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "hello", fw: "test", caps: { sanotts: true, servo: true, mic: true } })), false);
    expect(JSON.parse(String(socket.send.mock.calls[0]?.[0]))).toMatchObject({ type: "welcome", session: "session" });

    socket.emit("message", Buffer.from(JSON.stringify({ type: "event", kind: "button", where: "center" })), false);
    await expect(eventReceived).resolves.toEqual([{ deviceId: "device", payload: { type: "event", kind: "button", where: "center" } }]);
  });

  it("emits decoded microphone PCM and sends framed TTS PCM", async () => {
    const hub = new DeviceHub(logger);
    const socket = new FakeSocket();
    hub.connect("device", asWebSocket(socket), "session");
    const microphoneData = once(hub, "mic.data");
    socket.emit("message", Buffer.from(encodeBinaryFrame(BinaryKind.microphonePcm, 9, Uint8Array.from([1, 2]))), true);
    await expect(microphoneData).resolves.toEqual([
      { deviceId: "device", payload: { kind: BinaryKind.microphonePcm, seq: 9, data: Uint8Array.from([1, 2]) } },
    ]);

    expect(hub.sendBinary("device", 10, Uint8Array.from([3, 4]))).toBe(true);
    const sent = socket.send.mock.calls.at(-1)?.[0] as Uint8Array | undefined;
    expect(sent).toBeDefined();
    expect(Array.from(sent ?? [])).toEqual([BinaryKind.ttsPcm, 10, 0, 3, 4]);
  });
});
