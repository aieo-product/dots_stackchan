import { StreamingResampler } from './streaming-resampler.js';

/** Buffered compatibility helper using the same filter as streaming engines. */
export function resample24To16(data: Uint8Array): Uint8Array {
  return new StreamingResampler({ rate: 24000, channels: 1, format: 's16le' }).push(data, true);
}
