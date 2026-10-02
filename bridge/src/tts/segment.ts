import { replaceUrls } from './text.js';

/** Flush the first sentence immediately; group later short sentences to 15 characters. */
export function segment(text: string, minChars = 15): string[] {
  const sentences = replaceUrls(text).match(/[^。！？!?\n]+[。！？!?\n]*|[。！？!?\n]+/gu) ?? [];
  const output: string[] = [];
  let pending = '';
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed || !/[\p{L}\p{N}]/u.test(trimmed)) continue;
    pending += trimmed;
    if (output.length === 0 || Array.from(pending).length >= minChars) {
      output.push(pending);
      pending = '';
    }
  }
  if (pending) output.push(pending);
  return output;
}
