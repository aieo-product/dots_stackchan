export interface PcmFormat { rate: number; channels: number; format: 's16le' | 'f32le' }

/** Windowed-sinc low-pass filter. Byte/channel/filter history survives HTTP
 * boundaries. Only final flush pads the right edge. Memory is bounded by a chunk. */
export class StreamingResampler {
  private tail = new Uint8Array();
  private samples: number[] = [];
  private base = 0;
  private total = 0;
  private outputIndex = 0;
  private finished = false;
  private readonly radius: number;
  private readonly cutoff: number;
  constructor(private readonly input: PcmFormat) {
    if (!Number.isSafeInteger(input.rate) || input.rate <= 0 ||
      !Number.isSafeInteger(input.channels) || input.channels < 1 || input.channels > 2 ||
      !['s16le', 'f32le'].includes(input.format)) {
      throw new Error('Invalid PCM format');
    }
    this.radius = Math.ceil(24 * Math.max(1, input.rate / 24000));
    this.cutoff = Math.min(0.45, 0.45 * 16000 / input.rate);
  }
  push(bytes: Uint8Array, final = false): Uint8Array {
    if (this.finished) throw new Error('Resampler already flushed');
    const data = new Uint8Array(this.tail.length + bytes.length);
    data.set(this.tail); data.set(bytes, this.tail.length);
    const width = this.input.format === 's16le' ? 2 : 4;
    const frame = width * this.input.channels;
    const complete = data.length - data.length % frame;
    const view = new DataView(data.buffer);
    for (let i = 0; i < complete; i += frame) {
      let mono = 0;
      for (let c = 0; c < this.input.channels; c++) {
        const sample = width === 2 ? view.getInt16(i + c * width, true) / 32768 : view.getFloat32(i + c * width, true);
        if (!Number.isFinite(sample)) throw new Error('Invalid floating PCM sample');
        mono += sample / this.input.channels;
      }
      this.samples.push(mono); this.total++;
    }
    this.tail = data.slice(complete);
    if (final && this.tail.length) throw new Error('Invalid PCM: expected complete samples');
    const result: number[] = [];
    const ratio = this.input.rate / 16000;
    const end = Math.floor(this.total / ratio);
    while (this.outputIndex < end) {
      const position = this.outputIndex * ratio;
      if (!final && position + this.radius >= this.total) break;
      let sum = 0; let weight = 0;
      for (let j = Math.max(0, Math.ceil(position - this.radius)); j <= Math.min(this.total - 1, Math.floor(position + this.radius)); j++) {
        const distance = position - j;
        const sinc = distance === 0 ? 2 * this.cutoff : Math.sin(2 * Math.PI * this.cutoff * distance) / (Math.PI * distance);
        const kernel = sinc * (0.5 + 0.5 * Math.cos(Math.PI * distance / this.radius));
        sum += this.samples[j - this.base] * kernel; weight += kernel;
      }
      result.push(Math.max(-32768, Math.min(32767, Math.round(sum / weight * 32768))));
      this.outputIndex++;
    }
    const discard = Math.max(0, Math.min(this.samples.length, Math.ceil(this.outputIndex * ratio - this.radius) - this.base));
    this.samples.splice(0, discard); this.base += discard;
    this.finished = final;
    const output = new Uint8Array(result.length * 2);
    const outputView = new DataView(output.buffer);
    result.forEach((sample, i) => outputView.setInt16(i * 2, sample, true));
    return output;
  }
}
