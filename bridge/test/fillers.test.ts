import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Fillers } from "../src/fillers/controller.js";
import { readFillerConfig } from "../src/fillers/config.js";
import { bridgeToDeviceMessageSchema, BinaryKind, decodeBinaryFrame, encodeBinaryFrame } from "../src/protocol.js";

class Device extends EventEmitter {
  online = true;
  caps = { sanotts: true, servo: false, mic: true };
  send = vi.fn();
  sendBinary = vi.fn();
}
const phrases = [{ kind: "ack" as const, text: "うん" }, { kind: "wait" as const, text: "まだ調べてるよ" }];
const kana = { convert: vi.fn(async (text: string) => text) };
const router = { fillerPcm: vi.fn(async () => ({ sampleRate: 16000 as const, data: new Uint8Array(6000) })) };
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe("filler timers", () => {
  it.each([0, 7_999, 8_001, 15_999])("reply at %i ms cancels all remaining reminders", time => {
    vi.useFakeTimers();
    const device = new Device(); const fillers = new Fillers(device, phrases, kana, router);
    device.emit("message", { type: "mic.end", seq: 7 });
    vi.advanceTimersByTime(time); fillers.cancel(); vi.advanceTimersByTime(60_000);
    expect(device.send.mock.calls.filter(([message]) => message.type === "fillers.play")).toHaveLength(time >= 8_000 ? 1 : 0);
    expect(device.send).toHaveBeenLastCalledWith({ type: "fillers.cancel" }); fillers.dispose();
  });
  it("sends at 8 and 16 seconds, at most twice, before STT final text", () => {
    vi.useFakeTimers(); const device = new Device(); const fillers = new Fillers(device, phrases, kana, router);
    device.emit("message", { type: "mic.end", seq: 3 });
    vi.advanceTimersByTime(7_999); expect(device.send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(device.send).toHaveBeenCalledWith({ type: "fillers.play", seq: 3 });
    vi.advanceTimersByTime(60_000); expect(device.send).toHaveBeenCalledTimes(2); fillers.dispose();
  });
  it("new recording, disconnect and shutdown remove timers", () => {
    vi.useFakeTimers(); const device = new Device(); const fillers = new Fillers(device, phrases, kana, router);
    device.emit("message", { type: "mic.end", seq: 1 });
    vi.advanceTimersByTime(4_000); device.emit("message", { type: "mic.start", seq: 2 });
    device.emit("message", { type: "mic.end", seq: 2 });
    vi.advanceTimersByTime(8_000); expect(device.send).toHaveBeenLastCalledWith({ type: "fillers.play", seq: 2 });
    device.emit("offline"); vi.advanceTimersByTime(20_000); expect(vi.getTimerCount()).toBe(0);
    device.emit("message", { type: "mic.end", seq: 3 }); fillers.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
});

describe("connection-only filler preparation", () => {
  it("sends kana only to sanoTTS devices", async () => {
    const device = new Device(); const fillers = new Fillers(device, phrases, kana, router);
    await fillers.connect();
    expect(device.send).toHaveBeenLastCalledWith({ type: "fillers.set", phrases: phrases.map(p => ({ kind: p.kind, kana: p.text })) });
    expect(router.fillerPcm).not.toHaveBeenCalled(); expect(device.sendBinary).not.toHaveBeenCalled(); fillers.dispose();
  });
  it("synthesizes once per phrase at connect and sends bounded PCM cache frames", async () => {
    const device = new Device(); device.caps.sanotts = false;
    const fillers = new Fillers(device, phrases, kana, router); await fillers.connect();
    expect(router.fillerPcm).toHaveBeenCalledTimes(2); expect(kana.convert).not.toHaveBeenCalled();
    expect(device.send).toHaveBeenLastCalledWith({ type: "fillers.set", phrases: phrases.map(p => ({ kind: p.kind, samples: 3000 })) });
    expect(device.sendBinary).toHaveBeenCalledTimes(4);
    for (const [kind, seq, pcm] of device.sendBinary.mock.calls) {
      const frame = encodeBinaryFrame(kind, seq, pcm);
      expect(frame.length).toBeLessThanOrEqual(4096); expect(decodeBinaryFrame(frame).kind).toBe(BinaryKind.fillerPcm);
    }
    fillers.dispose();
  });
  it("empty config sends a clear and disables synthesis and timers", async () => {
    vi.useFakeTimers(); const device = new Device(); const fillers = new Fillers(device, [], kana, router);
    await fillers.connect(); device.emit("message", { type: "mic.end", seq: 1 });
    expect(device.send).toHaveBeenCalledExactlyOnceWith({ type: "fillers.set", phrases: [] });
    expect(vi.getTimerCount()).toBe(0); expect(kana.convert).not.toHaveBeenCalled(); fillers.dispose();
  });
  it("aborted preparation never sends to a replacement connection", async () => {
    const device = new Device(); let resolve!: (text: string) => void;
    const converter = { convert: () => new Promise<string>(done => { resolve = done; }) };
    const fillers = new Fillers(device, phrases.slice(0, 1), converter, router);
    const pending = fillers.connect(); device.emit("offline"); resolve("うん"); await pending;
    expect(device.send).toHaveBeenCalledTimes(1); fillers.dispose();
  });
  it("rejects excessive audio and logs only a fixed error callback", async () => {
    const device = new Device(); device.caps.sanotts = false; const error = vi.fn();
    const provider = { fillerPcm: async () => ({ sampleRate: 16000 as const, data: new Uint8Array(104_858) }) };
    const fillers = new Fillers(device, phrases, kana, provider, error); await fillers.connect();
    expect(error).toHaveBeenCalledExactlyOnceWith(); expect(device.sendBinary).not.toHaveBeenCalled(); fillers.dispose();
  });
});

it("validates filler config and wire metadata without shipping audio", () => {
  expect(readFillerConfig({})).toHaveLength(5);
  expect(readFillerConfig({ FILLER_PHRASES: "" })).toEqual([]);
  expect(readFillerConfig({ FILLER_PHRASES: "[]" })).toEqual([]);
  expect(() => readFillerConfig({ FILLER_PHRASES: '[{"kind":"bad","text":"うん"}]' })).toThrow();
  expect(() => readFillerConfig({ FILLER_PHRASES: 'private invalid value' })).toThrow();
  for (const phrase of [{ kind: "ack" }, { kind: "ack", kana: "うん", samples: 1 }, { kind: "wait", samples: 52429 }]) {
    expect(bridgeToDeviceMessageSchema.safeParse({ type: "fillers.set", phrases: [phrase] }).success).toBe(false);
  }
});
