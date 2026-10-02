import { afterEach, describe, expect, it, vi } from "vitest";
import { FakeStt } from "../src/stt/engine.js";
import { SttSession } from "../src/stt/session.js";
import { createLogger } from "../src/log.js";
import { MAX_PCM_BYTES } from "../src/stt/pcm.js";

function setup(options: { logTranscripts?: boolean; idleTimeoutMs?: number; resultTimeoutMs?: number } = {}) {
  const lines: string[] = [];
  const engine = new FakeStt();
  const session = new SttSession(engine, { logger: createLogger("debug", (line) => lines.push(line)), ...options });
  const utterance = vi.fn();
  session.on("utterance", utterance);
  return { lines, engine, session, utterance };
}

afterEach(() => vi.useRealTimers());

describe("SttSession", () => {
  it("streams immediately and emits exactly one final result, with private logs by default", async () => {
    const { lines, engine, session, utterance } = setup();
    const push = vi.spyOn(engine, "push");
    session.start(9);
    session.push(9, Buffer.alloc(640));
    expect(push).toHaveBeenCalledOnce();
    session.end(9);
    session.end(9);
    await vi.waitFor(() => expect(utterance).toHaveBeenCalledOnce());
    expect(utterance.mock.calls[0]?.[0]).toEqual({
      seq: 9, text: "こんにちは、スタックちゃん", lang: "ja", duration_ms: 20, latency_ms: expect.any(Number),
    });
    expect(lines.join("\n")).not.toContain("こんにちは");
    session.close();
  });

  it("allows transcript logging only when explicitly enabled", async () => {
    const { session, lines, utterance } = setup({ logTranscripts: true });
    session.start(1); session.push(1, Buffer.alloc(640)); session.end(1);
    await vi.waitFor(() => expect(utterance).toHaveBeenCalledOnce());
    expect(lines.join("\n")).toContain("こんにちは");
    session.close();
  });

  it("caps audio at 480000 bytes / 15 seconds even if a frame crosses the limit", async () => {
    const { session, engine, utterance } = setup();
    const push = vi.spyOn(engine, "push");
    session.start(1);
    session.push(1, Buffer.alloc(MAX_PCM_BYTES - 2));
    session.push(1, Buffer.alloc(640));
    session.push(1, Buffer.alloc(640));
    session.end(1);
    await vi.waitFor(() => expect(utterance).toHaveBeenCalledOnce());
    expect(push.mock.calls.map((call) => call[0].length)).toEqual([MAX_PCM_BYTES - 2, 2]);
    expect(utterance.mock.calls[0]?.[0].duration_ms).toBe(15_000);
    session.close();
  });

  it("ends by wall clock at 15 seconds without mic.end", async () => {
    vi.useFakeTimers();
    const { session, utterance } = setup({ idleTimeoutMs: 20_000 });
    session.start(2); session.push(2, Buffer.alloc(640));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(utterance).toHaveBeenCalledOnce();
    session.end(2);
    expect(utterance).toHaveBeenCalledOnce();
    session.close();
  });

  it("cancels idle/empty audio and ignores data/end outside a recording", async () => {
    vi.useFakeTimers();
    const { session, engine, utterance } = setup();
    const cancel = vi.spyOn(engine, "cancel");
    session.push(1, Buffer.alloc(640)); session.end(1);
    session.start(1); session.end(1);
    session.start(2); session.push(2, Buffer.alloc(640));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(utterance).not.toHaveBeenCalled();
    session.close();
  });

  it("rejects overlapping starts, wrong PCM sequence, and incomplete samples", async () => {
    const { session, engine, utterance, lines } = setup();
    const start = vi.spyOn(engine, "start");
    session.start(1); session.start(2);
    expect(start).toHaveBeenCalledOnce();
    session.push(2, Buffer.alloc(640)); session.end(1);
    session.start(3); session.push(3, Uint8Array.of(1)); session.end(3);
    await Promise.resolve();
    expect(utterance).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("sequence_mismatch");
    expect(lines.join("\n")).toContain("invalid_pcm");
    session.close();
  });

  it("ignores stale mic.end, forwards partials, and accepts uint16 sequence wrap", async () => {
    const { session, engine, utterance } = setup();
    const partial = vi.fn(); session.on("partial", partial);
    session.start(65_535); session.push(65_535, Buffer.alloc(640)); session.end(0);
    engine.emit("partial", "こんにちは");
    expect(partial).toHaveBeenCalledWith({ seq: 65_535, delta: "こんにちは" });
    session.end(65_535);
    await vi.waitFor(() => expect(utterance).toHaveBeenCalledOnce());
    session.start(0); session.push(0, Buffer.alloc(640)); session.end(0);
    await vi.waitFor(() => expect(utterance).toHaveBeenCalledTimes(2));
    session.close();
  });

  it("suppresses late results after timeout, cancellation, and close", async () => {
    vi.useFakeTimers();
    const { session, engine, utterance } = setup({ resultTimeoutMs: 50 });
    let resolve: ((result: { text: string; lang: string }) => void) | undefined;
    vi.spyOn(engine, "end").mockImplementation(() => new Promise((done) => { resolve = done; }));
    session.start(1); session.push(1, Buffer.alloc(640)); session.end(1);
    await vi.advanceTimersByTimeAsync(50);
    resolve?.({ text: "late", lang: "ja" }); await Promise.resolve();
    expect(utterance).not.toHaveBeenCalled();
    session.start(2); session.push(2, Buffer.alloc(640)); session.end(2); session.close();
    resolve?.({ text: "late", lang: "ja" }); await Promise.resolve();
    expect(utterance).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("logs provider failure without its potentially sensitive error message", async () => {
    const { session, engine, lines, utterance } = setup();
    vi.spyOn(engine, "end").mockRejectedValue(new Error("private transcript"));
    session.start(1); session.push(1, Buffer.alloc(640)); session.end(1);
    await vi.waitFor(() => expect(lines.join("\n")).toContain("transcription_failed"));
    expect(lines.join("\n")).not.toContain("private transcript");
    expect(utterance).not.toHaveBeenCalled();
    session.close();
  });
});
