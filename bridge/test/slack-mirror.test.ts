import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { SlackMirror } from "../src/slack/mirror.js";
import type { SlackClient, SlackMessage, SlackSession, SlackStatus } from "../src/slack/client.js";
import { createLogger } from "../src/log.js";

class FakeClient implements SlackClient {
  session: SlackSession = { channel: "DTESTDM", ownUserId: "USELFTEST", dotUserId: "UDOTTEST" };
  status: SlackStatus = "offline";
  messages = new Set<(m: SlackMessage) => void>();
  statuses = new Set<(s: SlackStatus) => void>();
  start = vi.fn(async () => { this.setStatus("online"); });
  stop = vi.fn(async () => { this.setStatus("offline"); });
  post = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
  onMessage(cb: (m: SlackMessage) => void) { this.messages.add(cb); return () => { this.messages.delete(cb); }; }
  onStatus(cb: (s: SlackStatus) => void) { this.statuses.add(cb); return () => { this.statuses.delete(cb); }; }
  emit(m: SlackMessage) { for (const cb of this.messages) cb(m); }
  setStatus(s: SlackStatus) { this.status = s; for (const cb of this.statuses) cb(s); }
}

const dotMessage: SlackMessage = {
  type: "message", channel: "DTESTDM", user: "UDOTTEST", text: "こんにちは。", ts: "1.001",
};
function setup(readSentences = 2) {
  const client = new FakeClient();
  const utterances = new EventEmitter();
  const notifications = { submit: vi.fn() };
  const onStatus = vi.fn();
  const lines: string[] = [];
  const mirror = new SlackMirror({ client, utterances, notifications, readSentences, onStatus,
    logger: createLogger("debug", (line) => lines.push(line)),
  });
  return { client, utterances, notifications, onStatus, mirror, lines };
}

describe("Slack DM mirror", () => {
  it("posts utterances unchanged and never creates mentions or threads", async () => {
    const { client, utterances, mirror } = setup();
    utterances.emit("utterance", { text: "stopped", lang: "ja" });
    await mirror.start();
    utterances.emit("utterance", { text: "話しかけた言葉", lang: "ja", reply_to: "mcp-only-id" });
    utterances.emit("utterance", { text: " ", lang: "ja" });
    expect(client.post).toHaveBeenCalledExactlyOnceWith("話しかけた言葉");
    await mirror.dispose();
  });

  it("submits unsolicited, threaded, and arbitrarily late Dot posts through notifications", async () => {
    const { client, notifications, mirror } = setup();
    await mirror.start();
    client.emit(dotMessage);
    client.emit({ ...dotMessage, ts: "2.001", thread_ts: "1.001", text: "返事だよ。" });
    client.emit({ ...dotMessage, ts: "999999.001", text: "遅い返事。" });
    expect(notifications.submit).toHaveBeenCalledTimes(3);
    expect(notifications.submit).toHaveBeenNthCalledWith(1, {
      source: "slack", priority: "normal", message: "こんにちは。", topicId: "slack:DTESTDM:1.001",
    });
    expect(notifications.submit).toHaveBeenNthCalledWith(2, expect.objectContaining({ topicId: "slack:DTESTDM:1.001" }));
    await mirror.dispose();
  });

  it("excludes all self posts, other senders, other DMs, and edits/deletions", async () => {
    const { client, notifications, mirror } = setup();
    await mirror.start();
    for (const change of [
      { user: "USELFTEST" }, { user: "UOTHERTEST" }, { channel: "DOTHERTEST" },
      { subtype: "message_changed" }, { subtype: "message_deleted" }, { subtype: "message_replied" },
      { user: "USELFTEST", bot_id: "UDOTTEST" },
    ]) client.emit({ ...dotMessage, ...change });
    expect(notifications.submit).not.toHaveBeenCalled();
    await mirror.dispose();
  });

  it("matches bot IDs and allows bot messages without a user field", async () => {
    const { client, notifications, mirror } = setup();
    client.session.dotUserId = "BDOTTEST";
    await mirror.start();
    client.emit({ ...dotMessage, user: undefined, bot_id: "BDOTTEST", subtype: "bot_message" });
    expect(notifications.submit).toHaveBeenCalledTimes(1);
    await mirror.dispose();
  });

  it("deduplicates retries across reconnects and restarts while allowing identical new posts", async () => {
    const { client, notifications, mirror } = setup();
    await mirror.start();
    client.emit(dotMessage);
    client.setStatus("reconnecting"); client.setStatus("online");
    client.emit(dotMessage);
    await mirror.stop(); await mirror.start();
    client.emit(dotMessage);
    client.emit({ ...dotMessage, ts: "2.001" });
    expect(notifications.submit).toHaveBeenCalledTimes(2);
    await mirror.dispose();
  });

  it("uses configured sentence limits and handles table-only messages", async () => {
    const { client, notifications, mirror } = setup(1);
    await mirror.start();
    client.emit({ ...dotMessage, text: "一。二。三。" });
    expect(notifications.submit).toHaveBeenLastCalledWith(expect.objectContaining({ message: "一。 続きは Slack を見てね。" }));
    client.emit({ ...dotMessage, ts: "2.001", text: "", hasTable: true });
    expect(notifications.submit).toHaveBeenLastCalledWith(expect.objectContaining({ message: "表があるよ。" }));
    await mirror.dispose();
  });

  it("reports offline, makes stopped callbacks inert, and removes client listeners on disposal", async () => {
    const { client, utterances, notifications, onStatus, mirror } = setup();
    await mirror.start(); await mirror.start();
    expect(client.start).toHaveBeenCalledTimes(1);
    await mirror.dispose();
    expect(onStatus).toHaveBeenLastCalledWith("offline");
    utterances.emit("utterance", { text: "stopped", lang: "ja" }); client.emit(dotMessage);
    expect(client.post).not.toHaveBeenCalled();
    expect(notifications.submit).not.toHaveBeenCalled();
    expect(client.messages.size).toBe(0); expect(client.statuses.size).toBe(0);
    await expect(mirror.start()).rejects.toThrow("disposed");
  });

  it("handles posting and notification failures without logging message/error details", async () => {
    const { client, utterances, notifications, mirror, lines } = setup();
    await mirror.start();
    client.post.mockRejectedValue(new Error("private-error"));
    utterances.emit("utterance", { text: "private-transcript", lang: "ja" });
    notifications.submit.mockImplementationOnce(() => { throw new Error("private-error"); });
    client.emit(dotMessage); client.emit(dotMessage);
    await Promise.resolve();
    expect(notifications.submit).toHaveBeenCalledTimes(2);
    expect(lines.join("\n")).not.toMatch(/private-error|private-transcript/);
    await mirror.dispose();
  });

  it("keeps the retry cache bounded", async () => {
    const { client, notifications, mirror } = setup();
    await mirror.start();
    for (let i = 0; i < 1_001; i++) client.emit({ ...dotMessage, ts: `${i}.001` });
    client.emit({ ...dotMessage, ts: "0.001" });
    expect(notifications.submit).toHaveBeenCalledTimes(1_002);
    await mirror.dispose();
  });

  it("shares pending startup and allows retry after a sanitized startup failure", async () => {
    const { client, mirror } = setup();
    client.start.mockRejectedValueOnce(new Error("private-error"));
    const first = mirror.start(); const second = mirror.start();
    expect(first).toBe(second);
    await expect(first).rejects.toThrow(/^Slack mirror start failed$/);
    await mirror.start();
    expect(client.start).toHaveBeenCalledTimes(2);
    await mirror.dispose();
  });
});
