import { EventEmitter, once } from "node:events";
import WebSocket from "ws";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  beforeEach(() => vi.clearAllMocks());

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

  it("tracks hello metadata through state changes, disconnect, and a new hello", () => {
    const hub = new DeviceHub(logger);
    const first = new FakeSocket();
    const caps = { sanotts: true, servo: false, mic: true };
    hub.connect("device", asWebSocket(first), "first");
    expect(hub.getDevice("device")).toEqual({ presence: "online" });
    first.emit("message", Buffer.from(JSON.stringify({ type: "hello", fw: "v1", caps })), false);
    first.emit("message", Buffer.from(JSON.stringify({ type: "state", state: "listening" })), false);
    expect(hub.getDevice("device")).toEqual({ presence: "online", state: "listening", caps, fw: "v1" });
    expect(hub.getStatus("device")).toEqual(hub.getDevice("device"));

    first.close();
    expect(hub.getDevice("device")).toEqual({ presence: "offline", caps });
    const second = new FakeSocket();
    hub.connect("device", asWebSocket(second), "second");
    expect(hub.getDevice("device")).toEqual({ presence: "online", caps });
    const updatedCaps = { sanotts: false, servo: true, mic: false };
    second.emit("message", Buffer.from(JSON.stringify({ type: "hello", fw: "v2", caps: updatedCaps })), false);
    expect(hub.getDevice("device")).toEqual({ presence: "online", caps: updatedCaps, fw: "v2" });
  });

  it("lists known online and offline devices and returns independent snapshots", () => {
    const hub = new DeviceHub(logger);
    expect(hub.listDevices()).toEqual([]);
    expect(hub.getDevice("unknown")).toEqual({ presence: "offline" });
    expect(hub.listDevices()).toEqual([]);
    const socket = new FakeSocket();
    const caps = { sanotts: true, servo: false, mic: true };
    hub.connect("first", asWebSocket(socket), "session");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "hello", fw: "v1", caps })), false);
    socket.close();
    hub.connect("second", asWebSocket(new FakeSocket()), "session");
    expect(hub.listDevices()).toEqual([
      { deviceId: "first", presence: "offline", caps },
      { deviceId: "second", presence: "online" },
    ]);
    const snapshot = hub.getDevice("first");
    if (snapshot.caps !== undefined) snapshot.caps.mic = false;
    const listed = hub.listDevices()[0];
    if (listed?.caps !== undefined) listed.caps.servo = true;
    expect(hub.getDevice("first").caps).toEqual(caps);
  });

  it("clears a disconnected device with no hello", () => {
    const hub = new DeviceHub(logger);
    const socket = new FakeSocket();
    hub.connect("device", asWebSocket(socket), "session");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "state", state: "thinking" })), false);
    socket.close();
    expect(hub.getDevice("device")).toEqual({ presence: "offline" });
  });

  it("ignores frames and a delayed close from a replaced connection", () => {
    const hub = new DeviceHub(logger);
    const first = new FakeSocket();
    first.close.mockImplementation(() => { first.readyState = WebSocket.CLOSING; });
    hub.connect("device", asWebSocket(first), "first");
    const second = new FakeSocket();
    hub.connect("device", asWebSocket(second), "second");
    const caps = { sanotts: true, servo: true, mic: true };
    second.emit("message", Buffer.from(JSON.stringify({ type: "hello", fw: "current", caps })), false);
    first.emit("message", Buffer.from(JSON.stringify({ type: "hello", fw: "stale", caps })), false);
    first.emit("close");
    expect(hub.getDevice("device")).toEqual({ presence: "online", caps, fw: "current" });
  });

  it("accepts additional fields and strips them from emitted messages", () => {
    const hub = new DeviceHub(logger);
    const socket = new FakeSocket();
    hub.connect("device", asWebSocket(socket), "session");
    const onState = vi.fn();
    hub.on("state", onState);
    socket.emit("message", Buffer.from(JSON.stringify({ type: "state", state: "idle", extra: true })), false);
    expect(onState).toHaveBeenCalledWith({ deviceId: "device", payload: { type: "state", state: "idle" } });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("ignores unknown types at debug level and continues processing known messages", () => {
    const hub = new DeviceHub(logger);
    const socket = new FakeSocket();
    hub.connect("device", asWebSocket(socket), "session");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "future.message", extra: true })), false);
    expect(logger.debug).toHaveBeenCalledWith("unknown_device_message", { device_id: "device" });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(socket.send).not.toHaveBeenCalled();
    socket.emit("message", Buffer.from(JSON.stringify({ type: "ping", t: 123, extra: true })), false);
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "pong", t: 123 }));
  });

  it("still warns for malformed known messages and invalid envelopes", () => {
    const hub = new DeviceHub(logger);
    const socket = new FakeSocket();
    hub.connect("device", asWebSocket(socket), "session");
    socket.emit("message", Buffer.from(JSON.stringify({ type: "state", state: "invalid" })), false);
    socket.emit("message", Buffer.from(JSON.stringify({ type: 42 })), false);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.debug).not.toHaveBeenCalled();
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
