const emojiWords: Readonly<Record<string, string>> = {
  smile: "にっこり", tada: "お祝い", warning: "注意", heart: "ハート",
  thumbsup: "いいね", "+1": "いいね",
};

function replaceTables(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inTable = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const tableRow = (row: string): boolean =>
      /^\s*\|.*\|\s*$/.test(row) || (row.match(/\|/g)?.length ?? 0) >= 2 || /\S\t+\S/.test(row);
    const isTable = tableRow(line) && (inTable || tableRow(lines[index + 1] ?? ""));
    if (isTable) {
      if (!inTable) result.push("表があるよ。");
      inTable = true;
    } else {
      inTable = false;
      result.push(line);
    }
  }
  return result.join("\n");
}

/** Convert mrkdwn locally; never resolve mentions, fetch URLs, or execute code. */
export function slackTextToSpeech(raw: string, readSentences = 2): string {
  if (!Number.isInteger(readSentences) || readSentences < 1 || readSentences > 20) {
    throw new Error("readSentences must be an integer from 1 to 20");
  }
  let text = raw.replace(/\r\n?/g, "\n")
    .replace(/```[^]*?(?:```|$)/g, "コードがあるよ。")
    .replace(/`[^`\n]+`/g, "コードがあるよ")
    .replace(/<(?:https?:\/\/|ftp:\/\/|mailto:)[^>]*>/gi, "リンクがあるよ")
    .replace(/\b(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>。！？]+/gi, "リンクがあるよ")
    .replace(/<@[A-Z0-9]+(?:\|[^>]+)?>/g, "メンションがあるよ")
    .replace(/<#[A-Z0-9]+(?:\|[^>]+)?>/g, "チャンネルへのリンクがあるよ")
    .replace(/<![^>]+>/g, "通知があるよ")
    .replace(/:([a-zA-Z0-9_+-]+):/g, (_match, code: string) => emojiWords[code] ?? "絵文字");
  text = replaceTables(text)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/^\s*>\s?/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ").trim();
  if (!text) return "";

  const sentences = Array.from(new Intl.Segmenter("ja", { granularity: "sentence" }).segment(text),
    ({ segment }) => segment.trim()).filter(Boolean);
  const selected = sentences.slice(0, readSentences).join(" ");
  // A single unpunctuated message must not monopolize the device's speech queue.
  const characters = Array.from(selected);
  const shortened = characters.length > 600;
  const spoken = shortened ? characters.slice(0, 600).join("") : selected;
  return shortened || sentences.length > readSentences
    ? `${spoken} 続きは Slack を見てね。` : spoken;
}
