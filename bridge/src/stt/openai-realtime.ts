import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { z } from "zod";
import type { SttEngine, SttResult } from "./engine.js";
import { MAX_PCM_BYTES, PcmBuffer, PcmResampler } from "./pcm.js";

export const DEFAULT_REALTIME_MODEL = "gpt-live-transcribe";
export interface OpenAiRealtimeOptions {
  apiKey: string;
  model?: string;
  language?: string;
  connect?: () => WebSocket;
  connectTimeoutMs?: number;
  finalTimeoutMs?: number;
}

const eventSchema = z.object({
  type: z.string(), item_id: z.string().optional(), delta: z.string().optional(), transcript: z.string().optional(),
});
interface Turn {
  queued: PcmBuffer;
  resampler: PcmResampler;
  bytes: number;
  itemId?: string;
  committed: boolean;
  ending: boolean;
  error?: Error;
  resolve?: (result: SttResult) => void;
  reject?: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

/** Persistent, preconnected transcription socket; failures are handled by FallbackStt. */
export class OpenAiRealtime extends EventEmitter implements SttEngine {
  private socket?: WebSocket;
  private ready = false;
  private closed = false;
  private connectTimer?: NodeJS.Timeout;
  private turn?: Turn;
  private lastItemId?: string;

  public constructor(private readonly options: OpenAiRealtimeOptions) { super(); }

  public prepare(): void {
    if (this.closed || this.socket !== undefined) return;
    try {
      const socket = this.options.connect?.() ?? new WebSocket("wss://api.openai.com/v1/realtime?intent=transcription", {
        headers: { Authorization: `Bearer ${this.options.apiKey}` }, maxPayload: 64 * 1_024,
        handshakeTimeout: this.options.connectTimeoutMs ?? 3_000,
      });
      this.socket = socket;
      this.connectTimer = setTimeout(() => this.fail(), this.options.connectTimeoutMs ?? 3_000);
      socket.on("error", () => { if (this.socket === socket) this.fail(); });
      socket.on("close", () => { if (this.socket === socket) this.fail(); });
      socket.on("unexpected-response", (_request, response) => {
        response.destroy();
        if (this.socket === socket) this.fail();
      });
      socket.on("open", () => {
        if (this.socket !== socket) return;
        try {
          const model = this.options.model ?? DEFAULT_REALTIME_MODEL;
          const language = this.options.language ?? "ja";
          const transcription = model.startsWith("gpt-live-transcribe")
            ? { model, languages: [language], keywords: ["スタックちゃん"], delay: "low" }
            : model.startsWith("gpt-transcribe")
              ? { model, languages: [language], keywords: ["スタックちゃん"] }
              : { model, language, prompt: "スタックちゃん" };
          this.send({
            type: "session.update", session: { type: "transcription", audio: { input: {
              format: { type: "audio/pcm", rate: 24_000 }, transcription, turn_detection: null,
            } } },
          });
        } catch { this.fail(); }
      });
      socket.on("message", (data) => {
        if (this.socket !== socket) return;
        try { this.handleEvent(JSON.parse(data.toString())); } catch { this.fail(); }
      });
    } catch { this.fail(); }
  }

  public start(): void {
    if (this.closed || this.turn !== undefined) throw new Error("Realtime STT turn is unavailable");
    this.turn = {
      queued: new PcmBuffer(), resampler: new PcmResampler(), bytes: 0, committed: false, ending: false,
    };
    this.prepare();
  }

  public push(pcm: Uint8Array): void {
    const turn = this.turn;
    if (turn === undefined || turn.ending || turn.error !== undefined) throw new Error("Realtime STT turn is unavailable");
    if (pcm.byteLength % 2 !== 0 || turn.bytes + pcm.byteLength > MAX_PCM_BYTES) throw new Error("Invalid STT audio");
    turn.bytes += pcm.byteLength;
    if (!this.ready) { turn.queued.append(pcm); return; }
    this.append(turn.resampler.push(pcm));
  }

  public end(): Promise<SttResult> {
    const turn = this.turn;
    if (turn === undefined || turn.ending) return Promise.reject(new Error("Realtime STT turn is unavailable"));
    if (turn.error !== undefined) { this.turn = undefined; return Promise.reject(turn.error); }
    turn.ending = true;
    return new Promise((resolve, reject) => {
      turn.resolve = resolve;
      turn.reject = reject;
      turn.timer = setTimeout(() => this.fail(), this.options.finalTimeoutMs ?? 2_000);
      if (this.ready) {
        try { this.commit(turn); } catch { this.fail(); }
      }
    });
  }

  public cancel(): void {
    const turn = this.turn;
    this.turn = undefined;
    if (turn !== undefined) {
      clearTimeout(turn.timer);
      turn.queued.clear();
      turn.reject?.(new Error("Realtime transcription cancelled"));
      // A fresh socket prevents a cancelled turn's late commit/results leaking into the next turn.
      this.dropSocket();
    }
  }
  public close(): void { this.closed = true; this.cancel(); this.dropSocket(); }

  private send(event: Record<string, unknown>): void {
    if (this.socket?.readyState !== WebSocket.OPEN || this.socket.bufferedAmount > 1_024 * 1_024) {
      throw new Error("Realtime transcription backpressure");
    }
    const socket = this.socket;
    socket.send(JSON.stringify(event), (error) => {
      if (error != null && this.socket === socket) this.fail();
    });
  }
  private append(pcm: Buffer): void {
    if (pcm.length > 0) this.send({ type: "input_audio_buffer.append", audio: pcm.toString("base64") });
  }
  private commit(turn: Turn): void {
    this.append(turn.resampler.flush());
    this.send({ type: "input_audio_buffer.commit" });
  }
  private handleEvent(candidate: unknown): void {
    const event = eventSchema.parse(candidate);
    if (event.type === "session.updated") {
      if (this.ready) return;
      clearTimeout(this.connectTimer);
      this.ready = true;
      const turn = this.turn;
      if (turn !== undefined && turn.error === undefined) {
        this.append(turn.resampler.push(turn.queued.bytes()));
        turn.queued.clear();
        if (turn.ending) this.commit(turn);
      }
      return;
    }
    if (event.type === "error" || event.type === "conversation.item.input_audio_transcription.failed") { this.fail(); return; }
    const turn = this.turn;
    if (turn === undefined || turn.error !== undefined || event.item_id === this.lastItemId) return;
    if (event.type === "input_audio_buffer.committed" && turn.ending && event.item_id !== undefined) {
      if (turn.itemId !== undefined && turn.itemId !== event.item_id) { this.fail(); return; }
      turn.itemId = event.item_id;
      turn.committed = true;
    }
    if (event.type === "conversation.item.input_audio_transcription.delta" && event.item_id !== undefined) {
      if (turn.itemId === undefined) turn.itemId = event.item_id;
      if (turn.itemId === event.item_id && event.delta !== undefined) this.emit("partial", event.delta);
    }
    if (event.type === "conversation.item.input_audio_transcription.completed" && turn.committed &&
        event.item_id === turn.itemId && event.transcript !== undefined) {
      clearTimeout(turn.timer);
      this.lastItemId = turn.itemId;
      this.turn = undefined;
      turn.resolve?.({ text: event.transcript, lang: this.options.language ?? "ja" });
    }
  }
  private fail(): void {
    this.dropSocket();
    const turn = this.turn;
    if (turn === undefined) return;
    turn.queued.clear();
    turn.error = new Error("Realtime transcription unavailable");
    clearTimeout(turn.timer);
    if (turn.reject !== undefined) { this.turn = undefined; turn.reject(turn.error); }
  }
  private dropSocket(): void {
    clearTimeout(this.connectTimer);
    const socket = this.socket;
    this.socket = undefined;
    this.ready = false;
    this.lastItemId = undefined;
    socket?.terminate();
  }
}
