import OpenAI from 'openai';
import type { TtsOptions } from './config.js';
import type { TtsEngine, PcmAudio, TtsLog } from './types.js';
import { collectAudio, responseBytes, resampleStream } from './audio-stream.js';
import { requestScope } from './http.js';
import { OpenAiTransport } from './openai-transport.js';

export type SpeechClient = Pick<OpenAI['audio']['speech'], 'create'>;

export class OpenAiTtsEngine implements TtsEngine {
  private request = 0;
  constructor(private readonly options: Pick<TtsOptions, 'TTS_VOICE' | 'TTS_INSTRUCTIONS'> & Partial<Pick<TtsOptions, 'TTS_MODEL'>>,
    private readonly client: SpeechClient, private readonly log?: TtsLog,
    private readonly transport?: OpenAiTransport, private readonly baseURL?: string) {}

  /** Create lazily: sanoTTS does not need OPENAI_API_KEY. Inject it into the process. */
  static create(options: Pick<TtsOptions, 'TTS_VOICE' | 'TTS_INSTRUCTIONS'> & Partial<Pick<TtsOptions, 'TTS_MODEL'>>,
    apiKey?: string, runtime: { log?: TtsLog; baseURL?: string } = {}): OpenAiTtsEngine {
    if (!apiKey) throw new Error('OpenAI TTS requires OPENAI_API_KEY');
    const transport = new OpenAiTransport(runtime.log);
    const client = new OpenAI({ apiKey, baseURL: runtime.baseURL, fetch: transport.fetch,
      timeout: 30000, maxRetries: 0, logLevel: 'off' });
    return new OpenAiTtsEngine(options, client.audio.speech, runtime.log, transport, client.baseURL);
  }

  async warmup(): Promise<void> { if (this.baseURL) await this.transport?.warmup(this.baseURL); }
  async dispose(): Promise<void> { await this.transport?.dispose(); }

  async synthesize(text: string, signal?: AbortSignal): Promise<PcmAudio> {
    return collectAudio(this.stream(text, signal));
  }

  async *stream(text: string, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    signal?.throwIfAborted();
    const scope = requestScope(30000, signal);
    const request = ++this.request;
    const startedAt = performance.now();
    const log: TtsLog = (event, fields) => this.log?.(event, { level: 'debug', request, ...fields });
    const model = this.options.TTS_MODEL ?? 'gpt-4o-mini-tts';
    try {
      log('tts.http_request', { model });
      const response = await this.client.create({ model, input: text,
        voice: this.options.TTS_VOICE, instructions: model === 'gpt-4o-mini-tts' ? this.options.TTS_INSTRUCTIONS || undefined : undefined,
        response_format: 'pcm' }, { signal: scope.signal });
      log('tts.http_headers', { headersMs: performance.now() - startedAt });
      const source = responseBytes(response, scope.signal);
      const measured = (async function* () {
        let first = true;
        for await (const bytes of source) {
          if (first && bytes.length) { first = false; log('tts.http_first_byte', { firstByteMs: performance.now() - startedAt }); }
          yield bytes;
        }
        log('tts.http_body', { bodyMs: performance.now() - startedAt });
      })();
      yield* resampleStream(measured, { rate: 24000, channels: 1, format: 's16le' }, log);
    } catch {
      signal?.throwIfAborted();
      if (scope.signal.aborted) throw new Error('OpenAI TTS timed out');
      // Provider errors may include input, credentials or request URLs.
      throw new Error('OpenAI TTS failed; check credentials, connectivity and voice configuration');
    } finally { scope.dispose(); }
  }
}
