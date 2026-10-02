import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_PCM_BYTES, PcmBuffer, PcmResampler, pcmToWav } from "../src/stt/pcm.js";

describe("STT audio", () => {
  it("builds a 16 kHz mono PCM16 WAV in memory", () => {
    const pcm = Uint8Array.of(0, 0, 255, 127);
    const wav = pcmToWav(pcm);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.readUInt32LE(4)).toBe(40);
    expect(wav.toString("ascii", 8, 16)).toBe("WAVEfmt ");
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt32LE(28)).toBe(32_000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.readUInt32LE(40)).toBe(4);
    expect(wav.subarray(44)).toEqual(Buffer.from(pcm));
  });
  it("bounds buffering and releases audio on clear", () => {
    const audio = new PcmBuffer();
    audio.append(Buffer.alloc(MAX_PCM_BYTES));
    expect(() => audio.append(Uint8Array.of(0, 0))).toThrow();
    audio.clear(); expect(audio.length).toBe(0); expect(audio.bytes()).toHaveLength(0);
    expect(() => audio.append(Uint8Array.of(0))).toThrow();
    expect(() => pcmToWav(Buffer.alloc(MAX_PCM_BYTES + 2))).toThrow();
  });
  it("resamples continuously across arbitrary frame boundaries to exactly 24 kHz", () => {
    const input = Buffer.alloc(640);
    for (let index = 0; index < 320; index++) input.writeInt16LE(index * 50, index * 2);
    const whole = new PcmResampler();
    const expected = Buffer.concat([whole.push(input), whole.flush()]);
    const frames = new PcmResampler();
    const chunks = [frames.push(input.subarray(0, 2)), frames.push(input.subarray(2, 14)), frames.push(input.subarray(14)), frames.flush()];
    expect(Buffer.concat(chunks)).toEqual(expected);
    expect(expected).toHaveLength(960);
    expect(expected.readInt16LE(0)).toBe(0);
    expect(expected.readInt16LE(2)).toBe(33);
    expect(expected.readInt16LE(958)).toBe(15_950);
    expect(() => frames.push(Uint8Array.of(0))).toThrow();
  });
  it("ships non-empty synthetic speech with the device audio format", () => {
    const wav = readFileSync(new URL("./fixtures/hello_ja.wav", import.meta.url));
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.length).toBeGreaterThan(32_000);
    expect(wav.length).toBeLessThan(MAX_PCM_BYTES + 44);
    expect(wav.subarray(44).some((byte) => byte !== 0)).toBe(true);
  });
});
