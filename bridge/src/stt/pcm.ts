export const SAMPLE_RATE = 16_000;
export const BYTES_PER_SECOND = SAMPLE_RATE * 2;
export const MAX_DURATION_MS = 15_000;
export const MAX_PCM_BYTES = BYTES_PER_SECOND * MAX_DURATION_MS / 1_000;

/** Fixed capacity also bounds memory for very many tiny frames. */
export class PcmBuffer {
  private data = Buffer.alloc(0);
  public length = 0;

  public append(pcm: Uint8Array): void {
    if (pcm.byteLength % 2 !== 0 || this.length + pcm.byteLength > MAX_PCM_BYTES) {
      throw new Error("Invalid or oversized STT audio");
    }
    if (this.data.length === 0) this.data = Buffer.alloc(MAX_PCM_BYTES);
    this.data.set(pcm, this.length);
    this.length += pcm.byteLength;
  }
  public bytes(): Buffer { return this.data.subarray(0, this.length); }
  public clear(): void { this.data = Buffer.alloc(0); this.length = 0; }
}

export function pcmToWav(pcm: Uint8Array): Buffer {
  if (pcm.byteLength % 2 !== 0 || pcm.byteLength > MAX_PCM_BYTES) throw new Error("Invalid STT audio");
  const wav = Buffer.alloc(44 + pcm.byteLength);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + pcm.byteLength, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(BYTES_PER_SECOND, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcm.byteLength, 40);
  wav.set(pcm, 44);
  return wav;
}

/** Linear 16→24 kHz interpolation with a continuous phase across input frames. */
export class PcmResampler {
  private samples = 0;
  private nextTick = 0;
  private previous = 0;

  public push(pcm: Uint8Array): Buffer {
    if (pcm.byteLength % 2 !== 0) throw new Error("Incomplete PCM sample");
    const input = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    const output = Buffer.alloc(Math.ceil(pcm.byteLength / 2 * 1.5) * 2 + 2);
    let written = 0;
    for (let offset = 0; offset < pcm.byteLength; offset += 2) {
      const current = input.getInt16(offset, true);
      const tick = this.samples * 3;
      while (this.nextTick <= tick) {
        const fraction = this.samples === 0 ? 1 : (this.nextTick - (tick - 3)) / 3;
        output.writeInt16LE(Math.round(this.previous + (current - this.previous) * fraction), written);
        written += 2;
        this.nextTick += 2;
      }
      this.previous = current;
      this.samples++;
    }
    return output.subarray(0, written);
  }
  public flush(): Buffer {
    if (this.nextTick >= this.samples * 3) return Buffer.alloc(0);
    this.nextTick += 2;
    const output = Buffer.alloc(2);
    output.writeInt16LE(this.previous);
    return output;
  }
}
