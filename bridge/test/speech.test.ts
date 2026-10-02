import { describe, expect, it, vi } from "vitest";
import { createSpeechQueue } from "../src/index.js";
import { readVoiceConfig, selectVoiceMode } from "../src/speech/config.js";
import { openAiPcmSource } from "../src/speech/openai-tts.js";
import { SpeechQueue } from "../src/speech/queue.js";
import { Pcm24To16 } from "../src/speech/resampler.js";
import { ProtocolSpeaker, type DeviceTransport, type Timing, type Utterance } from "../src/speech/speaker.js";

const japanese: Utterance = { text: "こんにちは", kana: "こんにちわ", language: "ja" };
const tick = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
class Transport implements DeviceTransport {
  messages: Readonly<Record<string, unknown>>[] = [];
  frames: Uint8Array[] = [];
  handlers = new Set<(seq: number, ok: boolean) => void>();
  async sendText(message: Readonly<Record<string, unknown>>) { this.messages.push(message); }
  async sendBinary(frame: Uint8Array) { this.frames.push(frame); }
  onDone(handler: (seq: number, ok: boolean) => void) {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }
  done(seq: number, ok = true) { this.handlers.forEach((handler) => handler(seq, ok)); }
}
function clock() {
  let now = 100;
  const log = vi.fn();
  const sleep = vi.fn(async (ms: number, signal: AbortSignal) => { signal.throwIfAborted(); now += ms; });
  return { now: () => now, log, sleep } satisfies Timing;
}
function pcm(samples: number[]) {
  const bytes = Buffer.alloc(samples.length * 2);
  samples.forEach((value, index) => bytes.writeInt16LE(value, index * 2));
  return bytes;
}

describe("voice selection", () => {
  it("defaults Japanese capable devices to device and others to bridge", () => {
    const config = readVoiceConfig({});
    expect(selectVoiceMode(config, true, "ja-JP")).toBe("device");
    expect(selectVoiceMode(config, false, "ja")).toBe("bridge");
    expect(selectVoiceMode(config, true, "en")).toBe("bridge");
  });
  it("honors explicit modes, voice and style and rejects invalid configuration", () => {
    const config = readVoiceConfig({ VOICE_MODE: "bridge", TTS_VOICE: "cedar", TTS_INSTRUCTIONS: "Calm" });
    expect(config).toEqual({ mode: "bridge", voice: "cedar", instructions: "Calm" });
    expect(selectVoiceMode(config, true, "ja")).toBe("bridge");
    expect(() => readVoiceConfig({ VOICE_MODE: "bad" })).toThrow("VOICE_MODE");
    expect(() => readVoiceConfig({ TTS_VOICE: "bad" })).toThrow("TTS_VOICE");
    expect(() => selectVoiceMode({ ...config, mode: "device" }, false, "ja")).toThrow("caps.sanotts");
    expect(() => selectVoiceMode({ ...config, mode: "device" }, true, "en")).toThrow("Japanese");
  });
  it("wires config and capability selection through the bridge entry point", async () => {
    const transport = new Transport();
    const queue = await createSpeechQueue(transport, { sanotts: true }, {});
    const result = queue.say(japanese);
    await tick();
    expect(transport.messages[0]).toEqual({ type: "voice.mode", mode: "device" });
    expect(transport.messages.at(-1)?.type).toBe("speak.kana");
    transport.done(0);
    await result;
  });
});

describe("stateful PCM resampling", () => {
  it("is identical for every byte split including odd HTTP boundaries", () => {
    const input = pcm(Array.from({ length: 97 }, (_, i) => Math.round(20000 * Math.sin(i / 4))));
    const reference = new Pcm24To16().push(input);
    expect(reference.length).toBe(Math.ceil(97 * 2 / 3) * 2);
    for (let split = 0; split <= input.length; split++) {
      const resampler = new Pcm24To16();
      expect(Buffer.concat([resampler.push(input.subarray(0, split)), resampler.push(input.subarray(split))])).toEqual(reference);
      resampler.finish();
    }
    const resampler = new Pcm24To16();
    expect(Buffer.concat([...input].map((byte) => resampler.push(Uint8Array.of(byte))))).toEqual(reference);
  });
  it("preserves DC gain, clips safely and rejects a partial sample", () => {
    const output = new Pcm24To16().push(pcm(Array(120).fill(-12000)));
    expect(output.readInt16LE(output.length - 2)).toBe(-12000);
    const resampler = new Pcm24To16();
    resampler.push(Uint8Array.of(1));
    expect(() => resampler.finish()).toThrow("Truncated");
  });
  it("filters out frequencies above the device Nyquist frequency", () => {
    function rms(frequency: number) {
      const output = new Pcm24To16().push(pcm(Array.from({ length: 2400 }, (_, i) =>
        Math.round(12000 * Math.sin(2 * Math.PI * frequency * i / 24000)))));
      const values = Array.from({ length: output.length / 2 - 50 }, (_, i) => output.readInt16LE((i + 50) * 2));
      return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
    }
    expect(rms(10000)).toBeLessThan(rms(1000) * 0.03);
  });
});

describe("OpenAI PCM HTTP streaming", () => {
  it("uses PCM audio streaming, configured voice/style and injected key", async () => {
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Uint8Array.of(1, 2)); controller.close(); } });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    const signal = new AbortController().signal;
    const source = openAiPcmSource({ voice: "coral", instructions: "Calm" }, "test-placeholder", fetcher);
    const chunks = [];
    for await (const chunk of source("Any language", signal)) chunks.push(chunk);
    expect(chunks).toEqual([Uint8Array.of(1, 2)]);
    const init = fetcher.mock.calls[0][1];
    expect(init?.signal).toBe(signal);
    expect(JSON.parse(String(init?.body))).toMatchObject({ input: "Any language", voice: "coral", instructions: "Calm", response_format: "pcm", stream_format: "audio" });
  });
  it("does not expose the provider error body", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("private diagnostic", { status: 401 }));
    const iterator = openAiPcmSource({ voice: "coral" }, "test-placeholder", fetcher)("text", new AbortController().signal);
    await expect(iterator[Symbol.asyncIterator]().next()).rejects.toThrow(/^OpenAI TTS HTTP 401$/);
  });
});

describe("Speaker and SpeechQueue", () => {
  it("forwards first audio before HTTP end, logs latency, frames ≤4KB and waits for tts.done", async () => {
    const transport = new Transport();
    const end = deferred<undefined>();
    const time = clock();
    const speaker = new ProtocolSpeaker(transport, () => "bridge", async function* () {
      yield pcm(Array(24000).fill(1000));
      await end.promise;
      yield pcm([100, 200, 300]);
    }, time);
    let finished = false;
    const result = speaker.speak({ ...japanese, receivedAt: 0 }, new AbortController().signal).then(() => { finished = true; });
    await tick();
    expect(transport.frames.length).toBeGreaterThan(0);
    expect(transport.messages.map((m) => m.type)).toEqual(["voice.mode", "tts.start"]);
    expect(time.log).toHaveBeenCalledWith("[tts] first_audio_ms=100.0 target_ms=800 met=true");
    end.resolve(undefined);
    await tick();
    expect(time.sleep).toHaveBeenCalled();
    expect(transport.messages.at(-1)?.type).toBe("tts.end");
    expect(finished).toBe(false);
    for (const frame of transport.frames) {
      expect(frame.length).toBeLessThanOrEqual(4096);
      expect(frame.length % 2).toBe(1);
      expect(frame[0]).toBe(2);
      expect(Buffer.from(frame).readUInt16LE(1)).toBe(0);
    }
    transport.done(99);
    await tick();
    expect(finished).toBe(false);
    transport.done(0);
    await result;
    expect(transport.handlers.size).toBe(0);
  });
  it("serializes device and bridge speech until playback finishes", async () => {
    const transport = new Transport();
    const source = vi.fn(async function* () { yield pcm([1, 2, 3]); });
    const speaker = new ProtocolSpeaker(transport, (u) => u.language === "ja" ? "device" : "bridge", source, clock());
    const queue = new SpeechQueue(speaker);
    const first = queue.say(japanese);
    const second = queue.say({ text: "Hello", language: "en" });
    await tick();
    expect(transport.messages.map((m) => m.type)).toEqual(["voice.mode", "speak.kana"]);
    expect(source).not.toHaveBeenCalled();
    transport.done(0);
    await first;
    await tick();
    expect(transport.messages.map((m) => m.type)).toEqual(["voice.mode", "speak.kana", "voice.mode", "tts.start", "tts.end"]);
    transport.done(1);
    await second;
  });
  it("aborts the HTTP stream mid-way and cancels pending speech", async () => {
    const transport = new Transport();
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(pcm([1, 2, 3]));
        init?.signal?.addEventListener("abort", () => controller.error(new Error("HTTP aborted")), { once: true });
      } });
      return new Response(body);
    });
    const source = openAiPcmSource({ voice: "coral" }, "test-placeholder", fetcher);
    const queue = new SpeechQueue(new ProtocolSpeaker(transport, () => "bridge", source, clock()));
    const active = queue.say(japanese);
    const pending = queue.say(japanese);
    const rejectedActive = expect(active).rejects.toThrow();
    const rejectedPending = expect(pending).rejects.toThrow("cancelled");
    await tick();
    expect(transport.frames).toHaveLength(1);
    queue.cancel();
    await Promise.all([rejectedActive, rejectedPending]);
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(transport.messages.map((m) => m.type)).toEqual(["voice.mode", "tts.start", "tts.cancel"]);
    expect(transport.handlers.size).toBe(0);
  });
  it("aborts on device failure without emitting tts.end", async () => {
    const transport = new Transport();
    let signal: AbortSignal | undefined;
    const source = async function* (_text: string, incoming: AbortSignal) {
      signal = incoming;
      yield pcm([1, 2, 3]);
      await new Promise<void>((_resolve, reject) => incoming.addEventListener("abort", () => reject(incoming.reason), { once: true }));
    };
    const result = new ProtocolSpeaker(transport, () => "bridge", source, clock()).speak(japanese, new AbortController().signal);
    const rejected = expect(result).rejects.toThrow("Device speech failed");
    await tick();
    transport.done(0, false);
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(transport.messages.at(-1)?.type).toBe("tts.cancel");
  });
  it("restarts bounded pacing after a long HTTP gap", async () => {
    const transport = new Transport();
    let now = 0;
    const time: Timing = {
      now: () => now,
      sleep: async (ms, signal) => { signal.throwIfAborted(); now += ms; },
      log: () => {},
    };
    const source = async function* () {
      yield pcm(Array(24000).fill(1000));
      now += 5000;
      yield pcm(Array(24000).fill(1000));
    };
    const result = new ProtocolSpeaker(transport, () => "bridge", source, time).speak(japanese, new AbortController().signal);
    await tick();
    expect(transport.messages.at(-1)?.type).toBe("tts.end");
    expect(now).toBeGreaterThan(5700); // second burst was paced despite the gap
    transport.done(0);
    await result;
  });
  it("logs an 800 ms target miss without dropping the speech", async () => {
    const transport = new Transport();
    const time = clock();
    const result = new ProtocolSpeaker(transport, () => "bridge", async function* () { yield pcm([1, 2, 3]); }, time)
      .speak({ ...japanese, receivedAt: -900 }, new AbortController().signal);
    await tick();
    expect(time.log).toHaveBeenCalledWith("[tts] first_audio_ms=1000.0 target_ms=800 met=false");
    transport.done(0);
    await result;
  });
  it("cancels device playback through the same queue contract", async () => {
    const transport = new Transport();
    const queue = new SpeechQueue(new ProtocolSpeaker(transport, () => "device", async function* () {}, clock()));
    const result = queue.say(japanese);
    const rejected = expect(result).rejects.toThrow("cancelled");
    await tick();
    queue.cancel();
    await rejected;
    expect(transport.messages.at(-1)?.type).toBe("tts.cancel");
    expect(transport.handlers.size).toBe(0);
    const next = queue.say(japanese);
    await tick();
    transport.done(1);
    await next;
  });
  it("rejects truncated or empty streams and recovers for the next utterance", async () => {
    for (const input of [Uint8Array.of(1), new Uint8Array()]) {
      const transport = new Transport();
      const result = new ProtocolSpeaker(transport, () => "bridge", async function* () { yield input; }, clock())
        .speak(japanese, new AbortController().signal);
      await expect(result).rejects.toThrow();
      expect(transport.messages.at(-1)?.type).toBe("tts.cancel");
    }
    const transport = new Transport();
    const queue = new SpeechQueue(new ProtocolSpeaker(transport, () => "device", async function* () {}, clock()));
    await expect(queue.say({ text: "漢字", language: "ja" })).rejects.toThrow("kana");
    const next = queue.say(japanese);
    await tick();
    transport.done(0);
    await next;
  });
});
