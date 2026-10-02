import OpenAI from 'openai';
import type { TtsOptions } from './config.js';
import type { TtsEngine, PcmAudio } from './types.js';
import { collectAudio, responseBytes, resampleStream } from './audio-stream.js';
import { requestScope } from './http.js';

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
    return collectAudio(this.stream(text, signal));
  }

  async *stream(text: string, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    signal?.throwIfAborted();
    const scope = requestScope(30000, signal);
    try {
      const response = await this.client.create({ model: 'gpt-4o-mini-tts', input: text,
        voice: this.options.TTS_VOICE, instructions: this.options.TTS_INSTRUCTIONS || undefined,
        response_format: 'pcm' }, { signal: scope.signal });
      yield* resampleStream(responseBytes(response, scope.signal), { rate: 24000, channels: 1, format: 's16le' });
    } catch {
      signal?.throwIfAborted();
      if (scope.signal.aborted) throw new Error('OpenAI TTS timed out');
      // Provider errors may include input, credentials or request URLs.
      throw new Error('OpenAI TTS failed; check credentials, connectivity and voice configuration');
    } finally { scope.dispose(); }
  }
}
