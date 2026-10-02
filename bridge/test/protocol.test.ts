import { describe, expect, it } from "vitest";

import {
  BinaryKind,
  bridgeToDeviceMessageSchema,
  decodeBinaryFrame,
  deviceToBridgeMessageSchema,
  encodeBinaryFrame,
  isUnknownDeviceMessage,
} from "../src/protocol.js";

describe("protocol schemas", () => {
  it.each([
    { type: "hello", fw: "test", caps: { sanotts: true, servo: true, mic: true } },
    { type: "state", state: "thinking" },
    { type: "event", kind: "button", where: "center" },
    { type: "mic.start", seq: 7, sample_rate: 16_000 },
    { type: "mic.end", seq: 7, reason: "release" },
    { type: "tts.done", seq: 7, ok: true },
    { type: "ping", t: 123 },
    { type: "pong", t: 123 },
  ])("accepts device message $type", (message) => {
    expect(deviceToBridgeMessageSchema.parse({ ...message, future_field: true })).toEqual(message);
  });

  it.each([
    { type: "welcome", session: "session", server_time: 123 },
    { type: "face", expression: "happy" },
    { type: "look", pan: 180, tilt: -90 },
    { type: "speak.kana", seq: 3, kana: "テスト", expression: "neutral" },
    { type: "tts.start", seq: 3, sample_rate: 24_000, channels: 1, bits: 16 },
    { type: "tts.end", seq: 3 },
    { type: "tts.cancel" },
    { type: "chime", kind: "notify" },
    { type: "notice.pending", count: 0 },
    { type: "voice.mode", mode: "device" },
    { type: "ping", t: 123 },
    { type: "pong", t: 123 },
  ])("accepts bridge message $type", (message) => {
    expect(bridgeToDeviceMessageSchema.safeParse(message).success).toBe(true);
    expect(bridgeToDeviceMessageSchema.safeParse({ ...message, future_field: true }).success).toBe(false);
  });

  it.each([-1, 0.5, "1", null])("rejects invalid notification counts: %j", count => {
    expect(bridgeToDeviceMessageSchema.safeParse({ type: "notice.pending", count }).success).toBe(false);
  });

  it("strips extra hello capability fields", () => {
    const caps = { sanotts: true, servo: false, mic: true };
    expect(deviceToBridgeMessageSchema.parse({ type: "hello", fw: "test", caps: { ...caps, display: true } }))
      .toEqual({ type: "hello", fw: "test", caps });
  });

  it.each([null, [], {}, { type: 42 }, { type: "state", state: "invalid" }, { type: "ping", t: "invalid" }])(
    "rejects malformed known messages and envelopes: %j", (message) => {
      expect(deviceToBridgeMessageSchema.safeParse(message).success).toBe(false);
      expect(isUnknownDeviceMessage(message)).toBe(false);
    },
  );

  it("identifies unknown types without weakening known message validation", () => {
    expect(isUnknownDeviceMessage({ type: "future.message", extra: true })).toBe(true);
    expect(isUnknownDeviceMessage({ type: "state", state: "idle" })).toBe(false);
  });
});

describe("binary frames", () => {
  it("round-trips kind, little-endian sequence, and PCM", () => {
    const encoded = encodeBinaryFrame(BinaryKind.microphonePcm, 0x1234, Uint8Array.from([5, 6]));
    expect([...encoded]).toEqual([0x01, 0x34, 0x12, 5, 6]);
    expect(decodeBinaryFrame(encoded)).toEqual({
      kind: BinaryKind.microphonePcm,
      seq: 0x1234,
      data: Uint8Array.from([5, 6]),
    });
  });

  it("enforces the 4KB total frame limit", () => {
    expect(() => encodeBinaryFrame(BinaryKind.ttsPcm, 1, new Uint8Array(4_094))).toThrow("4096");
  });

  it("rejects unknown kinds", () => {
    expect(() => decodeBinaryFrame(Uint8Array.from([0x04, 0, 0]))).toThrow("Unknown");
  });
});
