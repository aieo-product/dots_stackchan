import type { PcmAudio, TtsEngine } from './types.js';
import { collectAudio } from './audio-stream.js';
import { decodeAudioResponse } from './audio-response.js';
import { httpUrl, requestScope } from './http.js';

export class VoicevoxTtsEngine implements TtsEngine {
  private readonly base: URL;
  constructor(url: string, private readonly speaker: number, private readonly timeoutMs = 30000,
    private readonly fetcher: typeof fetch = fetch) {
    this.base = httpUrl(url.endsWith('/') ? url : `${url}/`, 'VOICEVOX_URL');
    if (!Number.isSafeInteger(speaker) || speaker < 0) throw new Error('Invalid VOICEVOX_SPEAKER');
  }
  synthesize(text: string, signal?: AbortSignal): Promise<PcmAudio> { return collectAudio(this.stream(text, signal)); }
  async *stream(text: string, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
    const scope = requestScope(this.timeoutMs, signal);
    try {
      const queryUrl = new URL('audio_query', this.base);
      queryUrl.searchParams.set('text', text); queryUrl.searchParams.set('speaker', String(this.speaker));
      const response = await this.fetcher(queryUrl, { method: 'POST', signal: scope.signal, redirect: 'error' });
      if (!response.ok) { await response.body?.cancel(); throw new Error('VOICEVOX query failed'); }
      const query: unknown = await response.json();
      if (!query || typeof query !== 'object' || Array.isArray(query)) throw new Error('Invalid VOICEVOX query');
      const synthesisUrl = new URL('synthesis', this.base);
      synthesisUrl.searchParams.set('speaker', String(this.speaker));
      const audio = await this.fetcher(synthesisUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(query), signal: scope.signal, redirect: 'error' });
      if (!audio.ok) { await audio.body?.cancel(); throw new Error('VOICEVOX synthesis failed'); }
      yield* decodeAudioResponse(audio, scope.signal);
    } catch {
      signal?.throwIfAborted();
      if (scope.signal.aborted) throw new Error('VOICEVOX timed out');
      throw new Error('VOICEVOX failed; start the engine and check VOICEVOX_URL and VOICEVOX_SPEAKER');
    } finally { scope.dispose(); }
  }
  async health(signal?: AbortSignal): Promise<'ready' | 'unavailable'> {
    const scope = requestScope(this.timeoutMs, signal);
    try {
      const response = await this.fetcher(new URL('version', this.base), { signal: scope.signal, redirect: 'error' });
      await response.body?.cancel(); return response.ok ? 'ready' : 'unavailable';
    } catch { signal?.throwIfAborted(); return 'unavailable'; }
    finally { scope.dispose(); }
  }
}
