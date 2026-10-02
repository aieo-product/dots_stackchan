import { expect, test } from 'vitest';
import { StreamingResampler, type PcmFormat } from '../src/tts/streaming-resampler.js';
import { sinePcm } from './fixtures/fake-local-tts.js';

test.each([24000, 48000, 44100, 16000, 8000])('arbitrary byte boundaries preserve filter history at %i Hz', rate => {
  for (const channels of [1, 2]) for (const format of ['s16le', 'f32le'] as const) {
    const input: PcmFormat = { rate, channels, format };
    const pcm = sinePcm(rate, channels, format);
    const expected = new StreamingResampler(input).push(pcm, true);
    const streaming = new StreamingResampler(input);
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < pcm.length;) {
      const length = 1 + (offset * 7 % 137);
      chunks.push(streaming.push(pcm.subarray(offset, offset + length))); offset += length;
    }
    chunks.push(streaming.push(new Uint8Array(), true));
    const result = Buffer.concat(chunks);
    expect(result).toEqual(Buffer.from(expected));
    expect(result).toHaveLength(3200);
  }
});
test('downmix averages stereo; incomplete and nonfinite samples fail', () => {
  const data = new Uint8Array(480 * 8); const view = new DataView(data.buffer);
  for (let i = 0; i < 480; i++) { view.setFloat32(i * 8, 0.5, true); view.setFloat32(i * 8 + 4, -0.5, true); }
  const format = { rate: 48000, channels: 2, format: 'f32le' } as const;
  expect(new StreamingResampler(format).push(data, true).every(byte => byte === 0)).toBe(true);
  expect(() => new StreamingResampler(format).push(data.subarray(1), true)).toThrow('complete');
  view.setFloat32(0, NaN, true);
  expect(() => new StreamingResampler(format).push(data)).toThrow('floating');
  expect(() => new StreamingResampler({ ...format, rate: 0 })).toThrow('format');
});
