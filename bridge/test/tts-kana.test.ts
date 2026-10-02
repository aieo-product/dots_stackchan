import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, test } from 'vitest';
import { labelsToKana, questionMark } from '../src/tts/labels.js';
import { OpenJtalkKanaConverter, preprocessText } from '../src/tts/kana.js';
import { phonemesToKana } from '../src/tts/phonemes.js';
import { WasmKanaConverter } from '../src/tts/wasm.js';

const goldens = JSON.parse(readFileSync(new URL('./fixtures/tts/golden.json', import.meta.url), 'utf8')) as {
 text: string; normalized: string; kana: string; labels: string[];
}[];
const wasm = await WasmKanaConverter.create();
afterAll(() => wasm.dispose());
describe('upstream full-context label port', () => {
 test.each(goldens)('$text', row => {
   expect(preprocessText(row.text)).toBe(preprocessText(row.normalized));
   expect(labelsToKana(row.labels, row.normalized)).toBe(row.kana);
 });
});
test('measure bundled WASM against upstream goldens without hiding mismatches', async () => {
 let matches = 0;
 for (const row of goldens) {
   const kana = await wasm.convert(row.text);
   expect(kana).toMatch(/[ぁ-ゖ]/u);
   expect(kana).not.toMatch(/[一-龯]/u);
   if (kana === row.kana) matches++;
 }
 console.info('WASM exact matches:', matches, '/', goldens.length);
 expect(matches).toBeGreaterThanOrEqual(16);
 expect(goldens).toHaveLength(45);
});
test('URL, emoji, symbols, whitespace and number preprocessing', () => {
 expect(preprocessText('**2026年** https://<your-host>/a ✅')).toBe('2026年 リンク');
 expect(preprocessText('👩‍💻')).toBe('');
});
test.each(['?', '?!', '?.', '?~'])('question EOS %s', mark => {
 expect(questionMark('確認します' + mark)).toBe(mark);
});
test('mid-mora marks, aliases and devoicing follow frozen table', () => {
 expect(phonemesToKana(['^', 'k', '[', 'I', 'N_uvular', '$'])).toBe('[き°ん');
 expect(() => phonemesToKana(['unknown'])).toThrow('unsupported');
});
test('empty and aborted conversions do not call phonemizer', async () => {
 const converter = new OpenJtalkKanaConverter({ phonemize: async () => { throw new Error('unexpected'); } });
 expect(await converter.convert('✅')).toBe('');
 await expect(converter.convert('こんにちは', AbortSignal.abort())).rejects.toThrow();
});
