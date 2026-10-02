import { findPackageJSON } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { labelsToKana } from './labels.js';
import { preprocessText } from './text.js';
import type { KanaConverter } from './types.js';

const table = JSON.parse(readFileSync(new URL('./mora-table.json', import.meta.url), 'utf8')) as {
  mora: Record<string, string[]>;
};
const tokens = ['^', '$', '_', '[', ']', '#', '?', '?!', '?.', '?~',
  ...new Set(Object.values(table.mora).flat()), 'N', 'N_m', 'N_n', 'N_ng', 'N_uvular', 'A', 'I', 'U', 'E', 'O'];
const phonemeMap = Object.fromEntries(tokens.map((token, i) => [token, [i + 1]]));
// The WASM encoder maps multi-letter phonemes to these fixed private-use characters.
const pua = { cl: 0xe005, ky: 0xe006, kw: 0xe007, gy: 0xe008, gw: 0xe009,
  ty: 0xe00a, dy: 0xe00b, py: 0xe00c, by: 0xe00d, ch: 0xe00e, ts: 0xe00f,
  sh: 0xe010, zy: 0xe011, hy: 0xe012, ny: 0xe013, my: 0xe014, ry: 0xe015,
  '?!': 0xe016, '?.': 0xe017, '?~': 0xe018, N_m: 0xe019, N_n: 0xe01a, N_ng: 0xe01b, N_uvular: 0xe01c };
for (const [token, code] of Object.entries(pua)) {
  if (phonemeMap[token]) phonemeMap[String.fromCodePoint(code)] = phonemeMap[token];
}

/** Bundled dictionary; no Python, native build or runtime download. Warm at startup. */
export class WasmKanaConverter implements KanaConverter {
  private constructor(private readonly phonemizer: import('piper-plus/wasm/multilingual').WasmPhonemizer) {}

  static async create(): Promise<WasmKanaConverter> {
    const wasm = await import('piper-plus/wasm/multilingual');
    const manifest = findPackageJSON('piper-plus', import.meta.url);
    if (!manifest) throw new Error('piper-plus WASM package unavailable');
    await wasm.default({ module_or_path: await readFile(new URL('./dist/rust-wasm/piper_plus_wasm_bg.wasm', pathToFileURL(manifest))) });
    return new WasmKanaConverter(new wasm.WasmPhonemizer(JSON.stringify({
      phoneme_id_map: phonemeMap, language_id_map: { ja: 0 },
    })));
  }

  async convert(text: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const input = preprocessText(text);
    if (!/[\p{L}\p{N}]/u.test(input)) return '';
    const result = this.phonemizer.phonemize(input, 'ja');
    try {
      const ids = result.phonemeIds;
      const prosody = result.prosodyFeatures;
      const labels: string[] = [];
      // Encoder layout: BOS PAD token PAD token ... PAD EOS.
      // Keep pauses at token positions; filtering PAD by value would lose them.
      for (let i = 2; i < ids.length - 1; i += 2) {
        const token = tokens[ids[i] - 1];
        if (!token) throw new Error('Unsupported WASM phoneme');
        if (['^', '$', '[', ']', '#', '?', '?!', '?.', '?~'].includes(token)) continue;
        const ph = token === '_' ? 'pau' : token;
        // Only A1/A2/A3 and the current phoneme are needed by text_to_intermediate.
        // The package exposes these label fields, rather than whole label strings.
        labels.push(`xx^xx-${ph}+xx=xx/A:${prosody[i * 3]}+${prosody[i * 3 + 1]}+${prosody[i * 3 + 2]}/`);
      }
      const kana = labelsToKana(labels, input);
      if (!/[ぁ-ゖ]/u.test(kana)) throw new Error('WASM produced no readable speech');
      signal?.throwIfAborted();
      return kana;
    } finally { result.free(); }
  }

  dispose(): void { this.phonemizer.free(); }
}
