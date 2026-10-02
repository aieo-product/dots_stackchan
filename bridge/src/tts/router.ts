import type { TtsOptions } from './config.js';
import type { KanaConverter, TtsEngine, DeviceLink, PcmAudio } from './types.js';
import { abortable } from './types.js';
import type { Expression } from './speaker.js';

export type SpeechPayload = { route: 'sanotts'; kana: string } | { route: 'openai'; audio: PcmAudio };

/** Han alone is ambiguous (e.g. Chinese); Japanese kana identifies mixed Japanese. */
export function isJapanese(text: string): boolean {
  return /[ぁ-ゖァ-ヺー]/u.test(text.normalize('NFKC')) && !/[\p{Script=Hangul}]/u.test(text);
}

export class TtsRouter {
  constructor(private readonly options: Pick<TtsOptions, 'TTS_ENGINE'>,
    private readonly kana: KanaConverter,
    private readonly openai: () => TtsEngine) {}

  async prepare(text: string, device: DeviceLink, signal: AbortSignal): Promise<SpeechPayload> {
    signal.throwIfAborted();
    if (!device.online) throw new Error('Speech device is offline');
    if (this.options.TTS_ENGINE === 'sanotts' && device.caps.sanotts && isJapanese(text)) {
      return { route: 'sanotts', kana: await abortable(this.kana.convert(text, signal), signal) };
    }
    return { route: 'openai', audio: await abortable(this.openai().synthesize(text, signal), signal) };
  }

  send(payload: SpeechPayload, device: DeviceLink, seq: number, signal: AbortSignal, expression?: Expression): void {
    signal.throwIfAborted();
    if (!device.online) throw new Error('Speech device is offline');
    if (payload.route === 'sanotts') {
      if (!payload.kana) return;
      device.send({ type: 'speak.kana', seq, kana: payload.kana, ...(expression ? { expression } : {}) });
      return;
    }
    const { data, sampleRate } = payload.audio;
    if (!data.byteLength || data.byteLength % 2) throw new Error('Invalid PCM audio');
    if (expression) device.send({ type: 'face', expression });
    device.send({ type: 'tts.start', seq, sample_rate: sampleRate, channels: 1, bits: 16 });
    // 3-byte protocol header + even-sized PCM payload <= 4096 bytes.
    for (let offset = 0; offset < data.byteLength; offset += 4092) {
      signal.throwIfAborted();
      device.sendBinary(0x02, seq, data.subarray(offset, offset + 4092));
    }
    signal.throwIfAborted();
    device.send({ type: 'tts.end', seq });
  }
}
