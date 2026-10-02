import type { PcmAudio, TtsEngine } from './types.js';
import { collectAudio } from './audio-stream.js';
import { decodeAudioResponse } from './audio-response.js';
import { httpUrl, requestScope } from './http.js';

export interface LocalTtsOptions {
  url: string; token?: string; voice?: string; style?: string;
  seed?: number; speed?: number; timeoutMs?: number;
}

export class LocalHttpTtsEngine implements TtsEngine {
  private readonly url: URL;
  constructor(private readonly options: LocalTtsOptions, private readonly fetcher: typeof fetch = fetch) {
    this.url = httpUrl(options.url, 'LOCAL_TTS_URL');
  }
  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', ...(this.options.token ? { Authorization: `Bearer ${this.options.token}` } : {}) };
  }
  synthesize(text: string, signal?: AbortSignal): Promise<PcmAudio> { return collectAudio(this.stream(text, signal)); }
  async *stream(text: string, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    signal?.throwIfAborted();
    if (Array.from(text).length > 500) throw new Error('Local TTS input exceeds 500 characters');
    const scope = requestScope(this.options.timeoutMs ?? 30000, signal);
    try {
      const { voice, style, seed, speed } = this.options;
      const response = await this.fetcher(this.url, { method: 'POST', headers: this.headers(),
        body: JSON.stringify({ text, voice, style, seed, speed }), signal: scope.signal, redirect: 'error' });
      if (!response.ok) { await response.body?.cancel(); throw new Error('TTS HTTP response failed'); }
      yield* decodeAudioResponse(response, scope.signal);
    } catch {
      signal?.throwIfAborted();
      if (scope.signal.aborted) throw new Error('Local TTS timed out');
      throw new Error('Local TTS failed; check server, URL and audio format');
    } finally { scope.dispose(); }
  }
  async health(signal?: AbortSignal): Promise<'ready' | 'unavailable' | 'unsupported'> {
    const scope = requestScope(this.options.timeoutMs ?? 30000, signal);
    try {
      const response = await this.fetcher(new URL('health', new URL('.', this.url)), { headers: this.headers(), signal: scope.signal, redirect: 'error' });
      await response.body?.cancel();
      return response.ok ? 'ready' : response.status === 404 ? 'unsupported' : 'unavailable';
    } catch { signal?.throwIfAborted(); return 'unavailable'; }
    finally { scope.dispose(); }
  }
}
