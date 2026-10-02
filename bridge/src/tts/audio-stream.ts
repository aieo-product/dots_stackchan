import { StreamingResampler, type PcmFormat } from './streaming-resampler.js';
import { abortable } from './types.js';

export const MAX_AUDIO_BYTES = 16 * 1024 * 1024;

export async function* responseBytes(response: Response, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  if (!response.ok || !response.body) throw new Error('TTS HTTP response failed');
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  let total = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const pending = reader.read();
      const { value, done } = signal ? await abortable(pending, signal) : await pending;
      signal?.throwIfAborted();
      if (done) break;
      total += value.length;
      if (total > MAX_AUDIO_BYTES) throw new Error('TTS audio exceeds size limit');
      for (let i = 0; i < value.length; i += 8192) yield value.subarray(i, i + 8192);
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
export function* frames(bytes: Uint8Array): Generator<Uint8Array> {
  for (let i = 0; i < bytes.length; i += 4092) yield bytes.subarray(i, i + 4092);
}
export async function* resampleStream(source: AsyncIterable<Uint8Array>, format: PcmFormat): AsyncGenerator<Uint8Array> {
  const resampler = new StreamingResampler(format);
  let count = 0;
  for await (const bytes of source) {
    const output = resampler.push(bytes);
    count += output.length; yield* frames(output);
  }
  const last = resampler.push(new Uint8Array(), true);
  count += last.length; yield* frames(last);
  if (!count) throw new Error('Empty TTS audio');
}
export async function collectAudio(source: AsyncIterable<Uint8Array>): Promise<{ data: Uint8Array; sampleRate: 16000 }> {
  const chunks: Uint8Array[] = []; let length = 0;
  for await (const bytes of source) {
    length += bytes.length;
    if (length > MAX_AUDIO_BYTES) throw new Error('TTS audio exceeds size limit');
    chunks.push(bytes);
  }
  const data = new Uint8Array(length); let offset = 0;
  for (const bytes of chunks) { data.set(bytes, offset); offset += bytes.length; }
  return { data, sampleRate: 16000 };
}
