import { describe, expect, it } from "vitest";
import { slackTextToSpeech } from "../src/slack/text.js";

describe("Slack speech text", () => {
  it("keeps short messages and truncates Japanese and English at sentence boundaries", () => {
    expect(slackTextToSpeech("こんにちは。元気？" )).toBe("こんにちは。 元気？");
    expect(slackTextToSpeech("一文目。二文目！三文目。"))
      .toBe("一文目。 二文目！ 続きは Slack を見てね。");
    expect(slackTextToSpeech("First. Second! Third?", 1))
      .toBe("First. 続きは Slack を見てね。");
    expect(slackTextToSpeech("一。二。三。", 3)).toBe("一。 二。 三。");
  });
  it("replaces fenced and inline code without reading its contents", () => {
    expect(slackTextToSpeech("```js\nsecretFunction();\n``` `secret`", 5))
      .toBe("コードがあるよ。 コードがあるよ");
    expect(slackTextToSpeech("```unterminated\nsecret" )).toBe("コードがあるよ。");
  });
  it("replaces URLs, mentions, channel links and emoji codes", () => {
    const result = slackTextToSpeech(
      "<https://example.com/path|Label> https://example.org。<@UTEST> <#CTEST|channel> <!here> :smile: :custom_emoji:", 10,
    );
    expect(result).toContain("リンクがあるよ");
    expect(result).toContain("メンションがあるよ");
    expect(result).toContain("チャンネルへのリンクがあるよ");
    expect(result).toContain("通知があるよ にっこり 絵文字");
    expect(result).not.toMatch(/https|Label|UTEST|CTEST|custom_emoji/);
  });
  it("replaces pipe and tab tables as a unit", () => {
    expect(slackTextToSpeech("| a | b |\n| --- | --- |\n| hidden | cells |"))
      .toBe("表があるよ。");
    expect(slackTextToSpeech("a\tb\nprivate\tcells" )).toBe("表があるよ。");
  });
  it("cleans markup, quotes and entities, and ignores empty text", () => {
    expect(slackTextToSpeech("> *hello* _world_ ~old~ &amp; &lt;value&gt;"))
      .toBe("hello world old & <value>");
    expect(slackTextToSpeech(" \n\t")).toBe("");
  });
  it("caps unpunctuated text without splitting Unicode characters", () => {
    expect(slackTextToSpeech("あ".repeat(700))).toBe(`${"あ".repeat(600)} 続きは Slack を見てね。`);
  });
  it.each([0, -1, 1.5, 21])("rejects an invalid sentence count %s", (count) => {
    expect(() => slackTextToSpeech("text", count)).toThrow("readSentences");
  });
});
