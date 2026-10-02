export function replaceUrls(text: string): string {
  return text.replace(/(?:https?:\/\/|www\.)[^\s。！？、]+/gu, 'リンク');
}

export function preprocessText(text: string): string {
  return replaceUrls(text).normalize('NFKC')
    .replace(/\p{Extended_Pictographic}|\uFE0F|\u200D/gu, ' ')
    .replace(/[〜~]/gu, '～').replace(/−/gu, '－')
    // Strip markup delimiters and unsupported symbols, retaining words and numbers.
    .replace(/[^\p{L}\p{N}\p{M}\s。、！？!?.,:;()「」『』ー～~－+\-/%]/gu, ' ')
    .replace(/\s+/gu, ' ').trim();
}
