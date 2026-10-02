import { expect, test, vi } from 'vitest';
import { OpenAiTtsEngine, type SpeechClient } from '../src/tts/openai.js';
import { resample24To16 } from '../src/tts/resample.js';
const options = { TTS_VOICE: 'coral', TTS_INSTRUCTIONS: 'Speak in a bright, cheerful and friendly tone.' };
function tone(frequency: number): Uint8Array {
 const data = new Uint8Array(24000 * 2);
 const view = new DataView(data.buffer);
 for (let i = 0; i < 24000; i++) view.setInt16(i * 2, Math.round(10000 * Math.sin(2 * Math.PI * frequency * i / 24000)), true);
 return data;
}
function rms(data: Uint8Array): number {
 const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
 let sum = 0;
 for (let i = 200; i < data.length / 2 - 200; i++) sum += view.getInt16(i * 2, true) ** 2;
 return Math.sqrt(sum / (data.length / 2 - 400));
}
test('one second resamples to 16000 samples; preserves DC, polarity and subarrays', () => {
 expect(resample24To16(tone(1000))).toHaveLength(32000);
 const bytes = new Uint8Array(100);
 const view = new DataView(bytes.buffer);
 for (let i = 0; i < 50; i++) view.setInt16(i * 2, -12345, true);
 const result = resample24To16(bytes.subarray(2, 98));
 expect(result).toHaveLength(64);
 expect(new DataView(result.buffer).getInt16(0, true)).toBe(-12345);
 expect(resample24To16(new Uint8Array())).toHaveLength(0);
 expect(() => resample24To16(new Uint8Array(3))).toThrow('complete');
});
test('low pass preserves 1kHz voice and rejects 10kHz aliasing', () => {
 expect(rms(resample24To16(tone(1000)))).toBeGreaterThan(6900);
 expect(rms(resample24To16(tone(10000)))).toBeLessThan(100);
});
test('OpenAI request uses PCM, voice, instructions and abort signal', async () => {
 const create = vi.fn().mockResolvedValue(new Response(new Uint8Array(tone(1000)).buffer));
 const engine = new OpenAiTtsEngine(options, { create } as unknown as SpeechClient);
 const signal = new AbortController().signal;
 const result = await engine.synthesize('Hello!', signal);
 expect(create).toHaveBeenCalledWith({ model: 'gpt-4o-mini-tts', input: 'Hello!', voice: 'coral',
  instructions: options.TTS_INSTRUCTIONS, response_format: 'pcm' }, { signal: expect.any(AbortSignal) });
 expect(result.sampleRate).toBe(16000);
 expect(result.data).toHaveLength(32000);
});
test('missing key and provider failure have clear sanitized errors', async () => {
 expect(() => OpenAiTtsEngine.create(options)).toThrow('OPENAI_API_KEY');
 const engine = new OpenAiTtsEngine(options, { create: vi.fn().mockRejectedValue(new Error('private provider detail')) } as unknown as SpeechClient);
 await expect(engine.synthesize('Hello!')).rejects.toThrow('OpenAI TTS failed');
 await expect(engine.synthesize('Hello!', AbortSignal.abort())).rejects.toThrow();
});
test('incomplete or empty audio fails before transmission', async () => {
 for (const data of [new Uint8Array(), new Uint8Array(3)]) {
  const engine = new OpenAiTtsEngine(options, { create: vi.fn().mockResolvedValue(new Response(data)) } as unknown as SpeechClient);
  await expect(engine.synthesize('Hello!')).rejects.toThrow('OpenAI TTS failed');
 }
});

test('speed-oriented tts-1 uses raw PCM without unsupported instructions', async () => {
 const create = vi.fn().mockResolvedValue(new Response(new Uint8Array(240)));
 const engine = new OpenAiTtsEngine({ ...options, TTS_MODEL: 'tts-1' }, { create } as unknown as SpeechClient);
 await engine.synthesize('Hello!');
 expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'tts-1', response_format: 'pcm',
  instructions: undefined }), expect.anything());
});
