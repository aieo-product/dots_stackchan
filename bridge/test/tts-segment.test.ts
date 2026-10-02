import { expect, test } from 'vitest';
import { segment } from '../src/tts/segment.js';
import { ttsEnvSchema } from '../src/tts/config.js';
test('first short sentence is immediate; following short sentences grouped', () => {
 expect(segment('はい。次です。これも短い。最後の文章は少し長くしました。')).toEqual([
  'はい。', '次です。これも短い。最後の文章は少し長くしました。',
 ]);
});
test('two sentences in acceptance example play in order', () => {
 expect(segment('こんにちは。今日もがんばろう。')).toEqual(['こんにちは。', '今日もがんばろう。']);
});
test('boundaries, blank lines, emoji only, and final fragment', () => {
 expect(segment('  一行目\n\n二行目！\n三行目？末尾', 1)).toEqual(['一行目', '二行目！', '三行目？', '末尾']);
 expect(segment('。！？\n✅')).toEqual([]);
 expect(segment('')).toEqual([]);
});
test('config defaults and bounds', () => {
 expect(ttsEnvSchema.parse({})).toMatchObject({ TTS_ENGINE: 'sanotts', KANA_ENGINE: 'wasm', TTS_MAX_CHARS: 500 });
 expect(ttsEnvSchema.parse({ KANA_ENGINE: 'python', TTS_ENGINE: 'openai', TTS_MAX_CHARS: '100' }).TTS_MAX_CHARS).toBe(100);
 expect(() => ttsEnvSchema.parse({ TTS_ENGINE: 'voicevox' })).toThrow();
 expect(() => ttsEnvSchema.parse({ TTS_MAX_CHARS: '501' })).toThrow();
});

test('replace URL before splitting so query punctuation is not spoken', () => {
 expect(segment('資料は https://<your-host>/a?x=1!y=2 を見てください。次へ。')).toEqual(['資料は リンク を見てください。', '次へ。']);
});
