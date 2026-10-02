import { expect, test, vi } from 'vitest';
import { isJapanese, TtsRouter } from '../src/tts/router.js';
import { FakeDevice, FakeTtsEngine } from './fixtures/tts/fakes.js';

test('Japanese mixed numerals and Latin words use kana; other scripts use PCM', () => {
 expect(isJapanese('2026年のCPU設定を確認します。')).toBe(true);
 for (const text of ['Hello!', '你好。', '안녕하세요', '123']) expect(isJapanese(text)).toBe(false);
});
test('sanoTTS default does not construct OpenAI; sends v1 kana and expression', async () => {
 const device = new FakeDevice();
 const openai = vi.fn(() => { throw new Error('no key'); });
 const router = new TtsRouter({ TTS_ENGINE: 'sanotts' }, { convert: async () => 'こ[んにちうぁ' }, openai);
 const signal = new AbortController().signal;
 const payload = await router.prepare('こんにちは。', device, signal);
 router.send(payload, device, 1, signal, 'happy');
 expect(openai).not.toHaveBeenCalled();
 expect(device.messages).toEqual([{ type: 'speak.kana', seq: 1, kana: 'こ[んにちうぁ', expression: 'happy' }]);
});
test.each(['foreign', 'capability', 'explicit'] as const)('PCM fallback: %s', async reason => {
 const device = new FakeDevice();
 device.caps.sanotts = reason !== 'capability';
 const engine = new FakeTtsEngine();
 const router = new TtsRouter({ TTS_ENGINE: reason === 'explicit' ? 'openai' : 'sanotts' },
  { convert: async () => { throw new Error('unexpected kana'); } }, () => engine);
 const signal = new AbortController().signal;
 const payload = await router.prepare(reason === 'foreign' ? 'Hello.' : 'こんにちは。', device, signal);
 router.send(payload, device, 27, signal, 'happy');
 expect(device.messages).toEqual([{ type: 'face', expression: 'happy' },
  { type: 'tts.start', seq: 27, sample_rate: 16000, channels: 1, bits: 16 }, { type: 'tts.end', seq: 27 }]);
 expect(device.binaries.map(frame => frame.data.length)).toEqual([4092, 4092, 1816]);
 expect(device.binaries.every(frame => frame.kind === 2 && frame.seq === 27 && frame.data.length + 3 <= 4096)).toBe(true);
 expect(device.binaries.reduce((bytes, frame) => bytes + frame.data.length, 0)).toBe(10000);
});
test('offline, abort and invalid PCM do not send frames', async () => {
 const device = new FakeDevice();
 const router = new TtsRouter({ TTS_ENGINE: 'openai' }, { convert: async () => '' }, () => new FakeTtsEngine());
 device.online = false;
 await expect(router.prepare('test', device, new AbortController().signal)).rejects.toThrow('offline');
 device.online = true;
 expect(() => router.send({ route: 'openai', audio: { data: new Uint8Array(1), sampleRate: 16000 } }, device, 1, new AbortController().signal)).toThrow('Invalid');
 expect(() => router.send({ route: 'sanotts', kana: 'あ' }, device, 1, AbortSignal.abort())).toThrow();
 expect(device.messages).toEqual([]);
});
