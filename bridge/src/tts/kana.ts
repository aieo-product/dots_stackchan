import { questionMark } from './labels.js';
import { phonemesToKana } from './phonemes.js';
import type { KanaConverter } from './types.js';

import { preprocessText } from './text.js';
export { preprocessText } from './text.js';

export interface Phonemizer {
  phonemize(text: string, signal?: AbortSignal): Promise<string[]>;
}

/** OpenJTalk supplies number/unknown-word readings, accent and devoicing. */
export class OpenJtalkKanaConverter implements KanaConverter {
  constructor(private readonly phonemizer: Phonemizer) {}

  async convert(text: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const input = preprocessText(text);
    if (!/[\p{L}\p{N}]/u.test(input)) return '';
    const phones = await this.phonemizer.phonemize(input, signal);
    signal?.throwIfAborted();
    const kana = phonemesToKana(phones.filter(phone => !['?', '?!', '?.', '?~'].includes(phone))) + questionMark(input);
    if (!kana || !/[ぁ-ゖ]/u.test(kana)) throw new Error('OpenJTalk produced no readable speech');
    return kana;
  }
}
