import OpenAI from 'openai';
import type { TtsOptions } from './config.js';
import type { TtsEngine, PcmAudio } from './types.js';
import { resample24To16 } from './resample.js';

export type SpeechClient = Pick<OpenAI['audio']['speech'], 'create'>;

export class OpenAiTtsEngine implements TtsEngine {
  constructor(private readonly options: Pick<TtsOptions, 'TTS_VOICE' | 'TTS_INSTRUCTIONS'>,
    private readonly client: SpeechClient) {}

  /** Create lazily: sanoTTS does not need OPENAI_API_KEY. Inject it into the process. */
  static create(options: Pick<TtsOptions, 'TTS_VOICE' | 'TTS_INSTRUCTIONS'>, apiKey?: string): OpenAiTtsEngine {
    if (!apiKey) throw new Error('OpenAI TTS requires OPENAI_API_KEY');
    return new OpenAiTtsEngine(options, new OpenAI({ apiKey, timeout: 30000, maxRetries: 1 }).audio.speech);
  }

  async synthesize(text: string, signal?: AbortSignal): Promise<PcmAudio> {
    signal?.throwIfAborted();
    try {
      const response = await this.client.create({ model: 'gpt-4o-mini-tts', input: text,
        voice: this.options.TTS_VOICE, instructions: this.options.TTS_INSTRUCTIONS,
        response_format: 'pcm' }, { signal });
      const pcm = new Uint8Array(await response.arrayBuffer());
      signal?.throwIfAborted();
      if (!pcm.byteLength || pcm.byteLength > 16 * 1024 * 1024) throw new Error('Invalid audio size');
      return { data: resample24To16(pcm), sampleRate: 16000 };
    } catch {
      signal?.throwIfAborted();
      // Provider errors may include input, credentials or request URLs.
      throw new Error('OpenAI TTS failed; check credentials, connectivity and voice configuration');
    }
  }
}
