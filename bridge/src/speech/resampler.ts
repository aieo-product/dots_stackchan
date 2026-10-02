// Causal 32-tap low-pass FIR, rational 2/3 conversion, signed PCM16 LE.
// Preserve byte alignment, filter history and fractional phase across HTTP chunks.
export class Pcm24To16 {
  private readonly history = new Float64Array(32);
  private readonly filters = [0, 0.5].map((fraction) => {
    const weights = Array.from({ length: 32 }, (_, k) => {
      const x = k - 15 - fraction;
      const cutoff = 0.31;
      const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
      return sinc * (0.54 - 0.46 * Math.cos(2 * Math.PI * k / 31));
    });
    const sum = weights.reduce((a, b) => a + b, 0);
    return weights.map((weight) => weight / sum);
  });
  private index = -1;
  private nextHalf = 0;
  private lowByte: number | undefined;

  push(bytes: Uint8Array): Buffer {
    const samples: number[] = [];
    for (const byte of bytes) {
      if (this.lowByte === undefined) {
        this.lowByte = byte;
        continue;
      }
      const unsigned = this.lowByte | (byte << 8);
      this.lowByte = undefined;
      this.index++;
      this.history[this.index % 32] = unsigned >= 32768 ? unsigned - 65536 : unsigned;
      if (this.index < Math.ceil(this.nextHalf / 2)) continue;
      const weights = this.filters[this.nextHalf % 2];
      let value = 0;
      for (let k = 0; k < 32; k++) {
        if (this.index >= k) value += this.history[(this.index - k) % 32] * weights[k];
      }
      samples.push(Math.max(-32768, Math.min(32767, Math.round(value))));
      this.nextHalf += 3;
    }
    const output = Buffer.alloc(samples.length * 2);
    samples.forEach((sample, i) => output.writeInt16LE(sample, i * 2));
    return output;
  }

  finish(): void {
    if (this.lowByte !== undefined) throw new Error("Truncated PCM16 sample");
  }
}
