/** Windowed-sinc low-pass interpolation: 24kHz signed PCM LE -> 16kHz mono.
 * Cutoff below output Nyquist avoids aliasing above 8kHz. */
export function resample24To16(data: Uint8Array): Uint8Array {
  if (data.byteLength % 2) throw new Error('Invalid PCM: expected complete 16-bit samples');
  const input = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const length = data.byteLength / 2;
  const output = new Uint8Array(Math.floor(length * 2 / 3) * 2);
  const view = new DataView(output.buffer);
  const radius = 24;
  const cutoff = 0.3;
  for (let i = 0; i < output.byteLength / 2; i++) {
    const position = i * 1.5;
    let sum = 0;
    let weight = 0;
    for (let j = Math.max(0, Math.ceil(position - radius)); j <= Math.min(length - 1, Math.floor(position + radius)); j++) {
      const distance = position - j;
      const sinc = distance === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * distance) / (Math.PI * distance);
      const kernel = sinc * (0.5 + 0.5 * Math.cos(Math.PI * distance / radius));
      sum += input.getInt16(j * 2, true) * kernel;
      weight += kernel;
    }
    view.setInt16(i * 2, Math.max(-32768, Math.min(32767, Math.round(sum / weight))), true);
  }
  return output;
}
