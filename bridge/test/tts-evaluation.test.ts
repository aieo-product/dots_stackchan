import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { labelsToKana } from '../src/tts/labels.js';
import { PythonOpenJtalkSidecar } from '../src/tts/sidecar.js';
import { OpenJtalkKanaConverter } from '../src/tts/kana.js';
import { WasmKanaConverter } from '../src/tts/wasm.js';
const goldens = JSON.parse(readFileSync(new URL('./fixtures/tts/golden.json', import.meta.url), 'utf8')) as {
 text: string; normalized: string; kana: string;
}[];
// Development-only evaluation; the default check never needs Python or network.
test.runIf(Boolean(process.env.TTS_EVAL_PYTHON))('optional Python accuracy and warm conversion benchmark', async () => {
 const sidecar = new PythonOpenJtalkSidecar({ command: process.env.TTS_EVAL_PYTHON,
  args: ['-u', fileURLToPath(new URL('../src/tts/openjtalk-sidecar.py', import.meta.url))] });
 const wasm = await WasmKanaConverter.create();
 try {
  await sidecar.start();
  const python = new OpenJtalkKanaConverter(sidecar);
  let matches = 0;
  const timings: number[] = [];
  const rows = [];
  for (const row of goldens) {
   const start = performance.now();
   const kana = await wasm.convert(row.text);
   timings.push(performance.now() - start);
   const accurate = await python.convert(row.text);
   if (accurate === row.kana) matches++;
   rows.push({ text: row.text, expected: row.kana, wasm: kana, python: accurate });
  }
  timings.sort((a, b) => a - b);
  console.info({ pythonMatches: matches, count: goldens.length, wasmP95Ms: timings[Math.floor(timings.length * 0.95)] });
  expect(matches).toBe(45);
  if (process.env.TTS_EVAL_WRITE === '1') writeFileSync(new URL('./fixtures/tts/evaluation.json', import.meta.url), JSON.stringify(rows, null, 2) + '\n');
 } finally { sidecar.dispose(); wasm.dispose(); }
}, 20000);

test.runIf(Boolean(process.env.TTS_EVAL_C_LABELS))('development C/WASM candidate evaluation', () => {
 const rows = JSON.parse(readFileSync(process.env.TTS_EVAL_C_LABELS ?? '', 'utf8')) as {
  text: string; normalized: string; kana: string; labels: string[];
 }[];
 expect(rows.filter(row => labelsToKana(row.labels, row.normalized) === row.kana)).toHaveLength(14);
 if (process.env.TTS_EVAL_WRITE === '1') writeFileSync(new URL('./fixtures/tts/c-wasm-evaluation.json', import.meta.url), JSON.stringify(rows.map(row => ({ text: row.text, kana: labelsToKana(row.labels, row.normalized) })), null, 2) + '\n');
});
