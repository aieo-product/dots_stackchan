import { once } from "node:events";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiRealtime } from "../src/stt/openai-realtime.js";

const resources: Array<{ engine: OpenAiRealtime; server: WebSocketServer }> = [];
afterEach(async () => {
  for (const { engine, server } of resources.splice(0)) {
    engine.close(); for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function setup(options: { acknowledge?: boolean; finalize?: boolean; finalTimeoutMs?: number; connectTimeoutMs?: number; model?: string } = {}) {
  const server = new WebSocketServer({ port: 0, host: "localhost" });
  await once(server, "listening");
  const messages: Array<Record<string, unknown>> = [];
  let peer: WebSocket | undefined;
  let turns = 0;
  let connections = 0;
  const send = (message: Record<string, unknown>): void => { peer?.send(JSON.stringify(message)); };
  server.on("connection", (socket) => {
    peer = socket; connections++;
    socket.on("message", (data) => {
      const event = JSON.parse(data.toString()) as Record<string, unknown>;
      messages.push(event);
      if (event.type === "session.update" && options.acknowledge !== false) send({ type: "session.updated" });
      if (event.type === "input_audio_buffer.commit" && options.finalize !== false) {
        turns++;
        send({ type: "input_audio_buffer.committed", item_id: `item-${turns}` });
        send({ type: "conversation.item.input_audio_transcription.completed", item_id: `item-${turns}`, transcript: "こんにちは、スタックちゃん" });
      }
    });
  });
  const engine = new OpenAiRealtime({ apiKey: "test-only-key", connect: () => new WebSocket(`ws://localhost:${(server.address() as AddressInfo).port}`), ...options });
  resources.push({ engine, server });
  return { engine, messages, send, get connections() { return connections; }, get peer() { return peer; } };
}

describe("OpenAiRealtime over WebSocket", () => {
  it("uses the current transcription schema, streams before end, and reuses a warm connection", async () => {
    const fixture = await setup(); const { engine, messages, send } = fixture;
    engine.prepare();
    await vi.waitFor(() => expect(messages[0]).toMatchObject({ type: "session.update", session: {
      type: "transcription", audio: { input: { format: { type: "audio/pcm", rate: 24_000 },
        transcription: { model: "gpt-live-transcribe", languages: ["ja"], keywords: ["スタックちゃん"], delay: "low" }, turn_detection: null } },
    } }));
    const partial = vi.fn(); engine.on("partial", partial);
    engine.start(); engine.push(Buffer.alloc(640));
    await vi.waitFor(() => expect(messages.some((message) => message.type === "input_audio_buffer.append")).toBe(true));
    expect(messages.some((message) => message.type === "input_audio_buffer.commit")).toBe(false);
    send({ type: "conversation.item.input_audio_transcription.delta", item_id: "item-1", delta: "こんにちは" });
    await vi.waitFor(() => expect(partial).toHaveBeenCalledWith("こんにちは"));
    await expect(engine.end()).resolves.toEqual({ text: "こんにちは、スタックちゃん", lang: "ja" });
    engine.start(); engine.push(Buffer.alloc(640));
    await engine.end();
    expect(fixture.connections).toBe(1);
    const append = messages.filter((message) => message.type === "input_audio_buffer.append");
    expect(append.reduce((sum, message) => sum + Buffer.from(String(message.audio), "base64").length, 0)).toBe(1_920);
  });

  it("queues PCM while configuring and commits after session.updated, correlating the final item", async () => {
    const { engine, messages, send } = await setup({ acknowledge: false, finalize: false });
    engine.start(); engine.push(Buffer.alloc(640)); const result = engine.end();
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    send({ type: "session.updated" });
    await vi.waitFor(() => expect(messages.at(-1)?.type).toBe("input_audio_buffer.commit"));
    send({ type: "input_audio_buffer.committed", item_id: "current" });
    send({ type: "conversation.item.input_audio_transcription.completed", item_id: "other", transcript: "wrong" });
    send({ type: "conversation.item.input_audio_transcription.completed", item_id: "current", transcript: "right" });
    await expect(result).resolves.toMatchObject({ text: "right" });
  });

  it("ignores late events from the preceding turn", async () => {
    const { engine, messages, send } = await setup({ finalize: false });
    engine.start(); engine.push(Buffer.alloc(640)); const first = engine.end();
    await vi.waitFor(() => expect(messages.at(-1)?.type).toBe("input_audio_buffer.commit"));
    send({ type: "input_audio_buffer.committed", item_id: "old" });
    send({ type: "conversation.item.input_audio_transcription.completed", item_id: "old", transcript: "first" });
    await first;
    const partial = vi.fn(); engine.on("partial", partial);
    engine.start(); engine.push(Buffer.alloc(640));
    send({ type: "conversation.item.input_audio_transcription.delta", item_id: "old", delta: "stale" });
    const next = engine.end();
    await vi.waitFor(() => expect(messages.filter((m) => m.type === "input_audio_buffer.commit")).toHaveLength(2));
    send({ type: "input_audio_buffer.committed", item_id: "new" });
    send({ type: "conversation.item.input_audio_transcription.completed", item_id: "new", transcript: "second" });
    await expect(next).resolves.toMatchObject({ text: "second" });
    expect(partial).not.toHaveBeenCalled();
  });

  it.each(["error", "close", "malformed", "timeout"] as const)("rejects safely on %s so batch can take over", async (failure) => {
    const fixture = await setup({ finalize: false, finalTimeoutMs: 150 });
    fixture.engine.start(); fixture.engine.push(Buffer.alloc(640)); const result = fixture.engine.end();
    const rejection = expect(result).rejects.toThrow("Realtime transcription unavailable");
    await vi.waitFor(() => expect(fixture.messages.at(-1)?.type).toBe("input_audio_buffer.commit"));
    if (failure === "error") fixture.send({ type: "error", error: { message: "private upstream details" } });
    if (failure === "close") fixture.peer?.close();
    if (failure === "malformed") fixture.peer?.send("invalid JSON");
    await rejection;
  });

  it("times out configuration and rejects end without an unhandled rejection", async () => {
    const { engine, messages } = await setup({ acknowledge: false, connectTimeoutMs: 150 });
    engine.start(); engine.push(Buffer.alloc(640));
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(engine.end()).rejects.toThrow("Realtime transcription unavailable");
  });

  it("cancels in-flight completion and opens a fresh connection next time", async () => {
    const fixture = await setup({ finalize: false });
    fixture.engine.start(); fixture.engine.push(Buffer.alloc(640)); const result = fixture.engine.end();
    const rejection = expect(result).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(fixture.messages.at(-1)?.type).toBe("input_audio_buffer.commit"));
    fixture.engine.cancel(); await rejection;
    fixture.engine.start(); fixture.engine.push(Buffer.alloc(640));
    await vi.waitFor(() => expect(fixture.connections).toBe(2));
    fixture.engine.cancel();
  });

  it("uses singular language for configurable legacy transcription models", async () => {
    const { engine, messages } = await setup({ model: "custom-transcriber" });
    engine.prepare();
    await vi.waitFor(() => expect(messages[0]).toMatchObject({ session: { audio: { input: {
      transcription: { model: "custom-transcriber", language: "ja", prompt: "スタックちゃん" },
    } } } }));
  });
});
