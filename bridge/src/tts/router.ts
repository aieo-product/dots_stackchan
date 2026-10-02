import type { TtsOptions } from './config.js';
import type { KanaConverter, TtsEngine, DeviceLink, PcmAudio } from './types.js';
import { abortable } from './types.js';
import type { Expression } from './speaker.js';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { frames } from './audio-stream.js';

export type PcmEngineName = 'openai' | 'voicevox' | 'local-http';
export type SpeechPayload = { route: 'sanotts'; kana: string } |
  { route: PcmEngineName; audio: PcmAudio } | { route: PcmEngineName; stream: AsyncIterable<Uint8Array> };
type RouterOptions = { VOICE_MODE?: TtsOptions['VOICE_MODE']; TTS_ENGINE: PcmEngineName | 'sanotts'; NOTIFY_TTS_ENGINE?: PcmEngineName };

/** Han alone is ambiguous (e.g. Chinese); Japanese kana identifies mixed Japanese. */
export function isJapanese(text: string): boolean {
  return /[ぁ-ゖァ-ヺー]/u.test(text.normalize('NFKC')) && !/[\p{Script=Hangul}]/u.test(text);
}

export class TtsRouter {
  constructor(private readonly options: RouterOptions,
    private readonly kana: KanaConverter,
    private readonly engine: (name: PcmEngineName) => TtsEngine) {}

  /** Invoke on connection/reconfiguration to show the selection before speaking. */
  announceMode(device: DeviceLink): void {
    if (!device.online) return;
    const mode = this.options.VOICE_MODE ?? (this.options.TTS_ENGINE === 'sanotts' ? 'device' : 'bridge');
    device.send({ type: 'voice.mode', mode: mode === 'device' && device.caps.sanotts ? 'device' : 'bridge',
      engine: mode === 'device' && device.caps.sanotts ? 'sanotts' : this.options.TTS_ENGINE === 'sanotts' ? 'openai' : this.options.TTS_ENGINE });
  }

  async health(purpose: 'reply' | 'notification' = 'reply', signal?: AbortSignal): Promise<'ready' | 'unavailable' | 'unsupported'> {
    const name = (purpose === 'notification' ? this.options.NOTIFY_TTS_ENGINE : undefined) ?? this.options.TTS_ENGINE;
    try { return await this.engine(name === 'sanotts' ? 'openai' : name).health?.(signal) ?? 'unsupported'; }
    catch { signal?.throwIfAborted(); return 'unavailable'; }
  }

  /** Connection-only fallback for devices without sanoTTS. Never persist audio. */
  async fillerPcm(text: string, signal: AbortSignal): Promise<PcmAudio> {
    const route = this.options.TTS_ENGINE;
    return abortable(this.engine(route === 'sanotts' ? 'openai' : route).synthesize(text, signal), signal);
  }

  async prepare(text: string, device: DeviceLink, signal: AbortSignal, purpose = 'reply'): Promise<SpeechPayload> {
    signal.throwIfAborted();
    if (!device.online) throw new Error('Speech device is offline');
    const mode = this.options.VOICE_MODE ?? (this.options.TTS_ENGINE === 'sanotts' ? 'device' : 'bridge');
    if (mode === 'device' && device.caps.sanotts && isJapanese(text)) {
      return { route: 'sanotts', kana: await abortable(this.kana.convert(text, signal), signal) };
    }
    const route = purpose === 'notification' ? this.options.NOTIFY_TTS_ENGINE ?? this.options.TTS_ENGINE : this.options.TTS_ENGINE;
    const name = route === 'sanotts' ? 'openai' : route;
    const engine = this.engine(name);
    if (!engine.stream) return { route: name, audio: await abortable(engine.synthesize(text, signal), signal) };
    const iterator = engine.stream(text, signal)[Symbol.asyncIterator]();
    const abort = () => { void iterator.return?.().catch(() => undefined); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      // Start HTTP immediately, prefetch just one output chunk for sentence N+1.
      const first = await abortable(iterator.next(), signal);
      if (first.done) throw new Error('Empty TTS stream');
      return { route: name, stream: (async function* () {
        try {
          yield first.value;
          while (true) { const next = await iterator.next(); if (next.done) break; yield next.value; }
        } finally { signal.removeEventListener('abort', abort); await iterator.return?.(); }
      })() };
    } catch (error) {
      signal.removeEventListener('abort', abort); await iterator.return?.(); throw error;
    }
  }

  async send(payload: SpeechPayload, device: DeviceLink, seq: number, signal: AbortSignal,
    expression?: Expression, firstAudio?: () => void): Promise<void> {
    signal.throwIfAborted();
    if (!device.online) throw new Error('Speech device is offline');
    if (payload.route === 'sanotts') {
      if (!payload.kana) return;
      device.send({ type: 'speak.kana', seq, kana: payload.kana, ...(expression ? { expression } : {}) });
      return;
    }
    if ('audio' in payload && (!payload.audio.data.byteLength || payload.audio.data.byteLength % 2)) throw new Error('Invalid PCM audio');
    if (expression) device.send({ type: 'face', expression });
    device.send({ type: 'tts.start', seq, sample_rate: 16000, channels: 1, bits: 16, voice_mode: 'bridge', engine: payload.route });
    const source = 'stream' in payload ? payload.stream : frames(payload.audio.data);
    let first = true; let audioClock = performance.now() - 200;
    for await (const bytes of source) {
      if (!bytes.length || bytes.length % 2) throw new Error('Invalid PCM audio');
      for (const frame of frames(bytes)) {
        // A 200ms burst budget fits the firmware's 500ms ring. Idle time does
        // not accumulate credit, including after HTTP stalls and underruns.
        audioClock = Math.max(audioClock, performance.now() - 200);
        const waitMs = audioClock - performance.now();
        if (waitMs > 0) await delay(waitMs, undefined, { signal });
        signal.throwIfAborted();
        if (!device.online) throw new Error('Speech device is offline');
        device.sendBinary(0x02, seq, frame);
        audioClock += frame.length / 32;
        if (first) { first = false; firstAudio?.(); }
      }
    }
    signal.throwIfAborted();
    device.send({ type: 'tts.end', seq });
  }
}
