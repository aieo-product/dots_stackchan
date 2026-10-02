import { readFileSync } from 'node:fs';

// The frozen sanoTTS table determines spelling and alias order, including
// extended morae. Do not replace aliases with visually nicer spellings.
const table = JSON.parse(readFileSync(new URL('./mora-table.json', import.meta.url), 'utf8')) as {
  mora: Record<string, string[]>;
};
const marks = new Set(['[', ']', '#', '_', '^', '$', '?', '?!', '?.', '?~']);
const reverse = new Map<string, string>();
for (const [kana, phones] of Object.entries(table.mora)) {
  const key = phones.join(' ');
  if (!reverse.has(key)) reverse.set(key, kana);
}
for (const nasal of ['N', 'N_m', 'N_n', 'N_ng', 'N_uvular']) reverse.set(nasal, 'ん');
for (const [kana, phones] of Object.entries(table.mora)) {
  if (/[aiueo]/.test(phones.at(-1) ?? '')) {
    const key = [...phones.slice(0, -1), (phones.at(-1) ?? '').toUpperCase()].join(' ');
    if (!reverse.has(key)) reverse.set(key, kana + '°');
  }
}

/** Port of the author's phonemes_to_intermediate, using its frozen table. */
export function phonemesToKana(input: readonly string[]): string {
  const phones: string[] = [];
  for (let i = 0; i < input.length; i++) {
    const p = input[i];
    if (!marks.has(p) && !/^[aiueoAIUEO]$/.test(p)
      && ['[', ']', '#'].includes(input[i + 1]) && /^[aiueoAIUEO]$/.test(input[i + 2] ?? '')) {
      phones.push(input[i + 1], p);
      i++;
    } else phones.push(p);
  }
  let kana = '';
  for (let i = 0; i < phones.length;) {
    if (marks.has(phones[i])) {
      // BOS/EOS are implicit in speak.kana; question EOS must be retained.
      if (phones[i] !== '^' && phones[i] !== '$') kana += phones[i];
      i++;
      continue;
    }
    const pair = reverse.get(phones.slice(i, i + 2).join(' '));
    const single = reverse.get(phones[i]);
    if (pair) { kana += pair; i += 2; }
    else if (single) { kana += single; i++; }
    else throw new Error('G2P returned an unsupported phoneme; speech was not sent');
  }
  return kana;
}
