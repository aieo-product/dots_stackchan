import { describe, expect, it } from "vitest";

import { NotificationContext } from "../src/notify/context.js";

describe("notification reply context", () => {
  it("returns reply_to for utterances starting within ten seconds of playback completion", () => {
    let now = 1_000;
    const context = new NotificationContext(() => now);
    expect(context.forUtterance()).toBeUndefined();
    context.recordPlayback("topic");
    expect(context.forUtterance(999)).toBeUndefined();
    expect(context.forUtterance(1_000)).toEqual({ reply_to: "topic" });
    expect(context.forUtterance(11_000)).toEqual({ reply_to: "topic" });
    expect(context.forUtterance(11_001)).toBeUndefined();
    now = 30_000;
    expect(context.forUtterance()).toBeUndefined();
    // Transcription may finish later than the utterance began.
    expect(context.forUtterance(5_000)).toEqual({ reply_to: "topic" });
  });

  it("replaces previous context and clears it for a notification without a topic", () => {
    const context = new NotificationContext(() => 1_000);
    context.recordPlayback("old");
    context.recordPlayback("new");
    expect(context.forUtterance()).toEqual({ reply_to: "new" });
    context.recordPlayback(undefined);
    expect(context.forUtterance()).toBeUndefined();
  });
});
