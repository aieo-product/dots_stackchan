import { frames, responseBytes, resampleStream, MAX_AUDIO_BYTES } from './audio-stream.js';
import { StreamingResampler, type PcmFormat } from './streaming-resampler.js';

class ByteReader {
  private chunk: Uint8Array = new Uint8Array();
  private offset = 0;
  readonly iterator: AsyncIterator<Uint8Array>;
  constructor(source: AsyncIterable<Uint8Array>) { this.iterator = source[Symbol.asyncIterator](); }
  async take(max: number): Promise<Uint8Array | undefined> {
    while (this.offset === this.chunk.length) {
      const next = await this.iterator.next();
      if (next.done) return;
      this.chunk = next.value; this.offset = 0;
    }
    const bytes = this.chunk.subarray(this.offset, this.offset + max);
    this.offset += bytes.length;
    return bytes;
  }
  async exact(length: number): Promise<Uint8Array> {
    const result = new Uint8Array(length); let offset = 0;
    while (offset < length) {
      const bytes = await this.take(length - offset);
      if (!bytes) throw new Error('Truncated WAV');
      result.set(bytes, offset); offset += bytes.length;
    }
    return result;
  }
  async skip(length: number): Promise<void> {
    if (length > MAX_AUDIO_BYTES) throw new Error('Invalid WAV chunk size');
    while (length) {
      const bytes = await this.take(length);
      if (!bytes) throw new Error('Truncated WAV');
      length -= bytes.length;
    }
  }
}
const ascii = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** Parses headers incrementally, including odd JUNK/LIST chunks and extensible fmt.
 * No complete WAV or utterance needs to be buffered before the first output. */
export async function* wavStream(source: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = new ByteReader(source);
  try {
    const header = await reader.exact(12);
    if (ascii(header.subarray(0, 4)) !== 'RIFF' || ascii(header.subarray(8)) !== 'WAVE') throw new Error('Invalid WAV header');
    let format: PcmFormat | undefined;
    while (true) {
      const chunk = await reader.exact(8);
      const id = ascii(chunk.subarray(0, 4));
      const size = new DataView(chunk.buffer).getUint32(4, true);
      if (id === 'fmt ') {
        if (size < 16 || size > 4096) throw new Error('Invalid WAV format');
        const bytes = await reader.exact(size);
        const view = new DataView(bytes.buffer);
        let encoding = view.getUint16(0, true);
        if (encoding === 65534 && size >= 40) encoding = view.getUint16(24, true);
        const bits = view.getUint16(14, true);
        if (!((encoding === 1 && bits === 16) || (encoding === 3 && bits === 32))) throw new Error('Unsupported WAV encoding');
        format = { rate: view.getUint32(4, true), channels: view.getUint16(2, true), format: encoding === 1 ? 's16le' : 'f32le' };
        if (view.getUint16(12, true) !== format.channels * bits / 8) throw new Error('Invalid WAV alignment');
      } else if (id === 'data') {
        if (!format) throw new Error('WAV format missing');
        const resampler = new StreamingResampler(format);
        const unknownLength = size === 0xffffffff;
        if (!unknownLength && size > MAX_AUDIO_BYTES) throw new Error('Invalid WAV data size');
        let remaining = size; let count = 0;
        while (remaining) {
          const bytes = await reader.take(Math.min(remaining, 8192));
          if (!bytes) {
            if (!unknownLength) throw new Error('Truncated WAV data');
            break;
          }
          remaining -= bytes.length;
          const output = resampler.push(bytes); count += output.length; yield* frames(output);
        }
        const last = resampler.push(new Uint8Array(), true); count += last.length; yield* frames(last);
        if (!count) throw new Error('Empty WAV audio');
        return;
      } else await reader.skip(size);
      if (size % 2) await reader.skip(1);
    }
  } finally { await reader.iterator.return?.(); }
}

export async function* decodeAudioResponse(response: Response, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  try {
  const content = response.headers.get('content-type')?.toLowerCase() ?? '';
  const [type, ...parameters] = content.split(';').map(part => part.trim());
  const source = responseBytes(response, signal);
  if (type === 'audio/wav' || type === 'audio/x-wav') { yield* wavStream(source); return; }
  if (type !== 'audio/pcm') { await response.body?.cancel(); throw new Error('Unsupported TTS content type'); }
  const params = Object.fromEntries(parameters.map(part => part.split('=').map(value => value.trim())));
  if (!['s16le', 'f32le'].includes(params.format)) { await response.body?.cancel(); throw new Error('Unsupported PCM encoding'); }
  yield* resampleStream(source, { rate: Number(params.rate), channels: Number(params.channels), format: params.format as PcmFormat['format'] });
  } finally {
    // Validation can fail before the lazy byte generator acquires its reader.
    if (response.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
  }
}
