import { phonemesToKana } from './phonemes.js';

export function questionMark(text: string): string {
  const end = text.trim().normalize('NFKC').replace(/〜/gu, '～');
  if (/(?:\?!|!\?)$/u.test(end)) return '?!';
  if (/(?:\?\.|。\?|\?。)$/u.test(end)) return '?.';
  if (/(?:\?[~～]|[~～]\?)$/u.test(end)) return '?~';
  return end.endsWith('?') ? '?' : '';
}

/** Port of text_to_intermediate's full-context label/prosody extraction.
 * N allophones share the frozen table's ん spelling, so no nasal rewrite is needed.
 */
export function labelsToKana(labels: readonly string[], text: string): string {
  const phones: string[] = [];
  for (let i = 0; i < labels.length; i++) {
    const ph = /-([^+]+)\+/u.exec(labels[i])?.[1];
    if (!ph) throw new Error('Invalid OpenJTalk label');
    if (ph === 'sil') continue;
    if (ph === 'pau') { phones.push('_'); continue; }
    phones.push(ph);
    const a = /\/A:([-\d]+)\+(\d+)\+(\d+)\//u.exec(labels[i]);
    if (!a) continue;
    const [, a1, a2, a3] = a.map(Number);
    const next = /\/A:([-\d]+)\+(\d+)\+(\d+)\//u.exec(labels[i + 1] ?? '');
    const a2Next = next ? Number(next[2]) : -1;
    if (a1 === 0 && a2Next === a2 + 1) phones.push(']');
    if (a2 === a3 && a2Next === 1) phones.push('#');
    if (a2 === 1 && a2Next === 2) phones.push('[');
  }
  return phonemesToKana(phones) + questionMark(text);
}
