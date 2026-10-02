import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/log.js";
import { SocketSlackClient } from "../src/slack/client.js";
import type { EnabledSlackConfig } from "../src/slack/config.js";

const constructors = vi.hoisted(() => ({ web: vi.fn(), socket: vi.fn() }));
vi.mock("@slack/web-api", () => ({ WebClient: constructors.web, LogLevel: { ERROR: "error" } }));
vi.mock("@slack/socket-mode", () => ({ SocketModeClient: constructors.socket }));

const config: EnabledSlackConfig = {
  enabled: true, appToken: ["xapp", "test-only"].join("-"),
  userToken: ["xoxp", "test-only"].join("-"), dotUserId: "UDOTTEST", readSentences: 2,
};

function fakeSdk() {
  const socket = Object.assign(new EventEmitter(), {
    start: vi.fn(async () => { socket.emit("connected"); }),
    disconnect: vi.fn(async () => { socket.emit("disconnected"); }),
  });
  const web = {
    auth: { test: vi.fn<() => Promise<unknown>>().mockResolvedValue({ ok: true, user_id: "USELFTEST" }) },
    conversations: { list: vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
      ok: true, channels: [{ id: "DTESTDM", is_im: true, user: "UDOTTEST" }],
    }) },
    users: { info: vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({
      ok: true, user: { profile: { bot_id: "BDOTTEST" } },
    }) },
    chat: { postMessage: vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ ok: true }) },
  };
  constructors.web.mockImplementation(function () { return web; });
  constructors.socket.mockImplementation(function () { return socket; });
  return { socket, web };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const event = {
  type: "message", channel_type: "im", channel: "DTESTDM", user: "UDOTTEST", text: "こんにちは。", ts: "1.001",
};

describe("Socket Slack client", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("uses app and user tokens separately and posts as the user in the existing DM", async () => {
    const { web } = fakeSdk();
    const client = new SocketSlackClient(config);
    await client.start();
    expect(constructors.web).toHaveBeenCalledWith(config.userToken, expect.objectContaining({
      retryConfig: { retries: 0 }, rejectRateLimitedCalls: true,
    }));
    expect(constructors.socket).toHaveBeenCalledWith(expect.objectContaining({
      appToken: config.appToken, autoReconnectEnabled: true,
    }));
    expect(client.session).toEqual({ channel: "DTESTDM", ownUserId: "USELFTEST", dotUserId: "UDOTTEST" });
    await client.post("発話そのまま");
    expect(web.chat.postMessage).toHaveBeenCalledWith({
      channel: "DTESTDM", text: "発話そのまま", mrkdwn: false, parse: "none",
      unfurl_links: false, unfurl_media: false,
    });
    await client.stop();
  });

  it("paginates empty pages and verifies an explicit DM belongs to Dot", async () => {
    const { web } = fakeSdk();
    web.conversations.list.mockResolvedValueOnce({ ok: true, channels: [], response_metadata: { next_cursor: "next" } });
    const client = new SocketSlackClient({ ...config, channel: "DTESTDM" });
    await client.start();
    expect(web.conversations.list).toHaveBeenLastCalledWith({ types: "im", limit: 200, cursor: "next" });
    await client.stop();
    web.conversations.list.mockResolvedValue({ ok: true, channels: [{ id: "DTESTDM", is_im: true, user: "UOTHER" }] });
    await expect(client.start()).rejects.toThrow("Slack start failed");
  });

  it("resolves a configured bot ID through DM peers without a bot token", async () => {
    const { web } = fakeSdk();
    const client = new SocketSlackClient({ ...config, dotUserId: "BDOTTEST" });
    await client.start();
    expect(web.users.info).toHaveBeenCalledWith({ user: "UDOTTEST" });
    expect(client.session?.dotUserId).toBe("BDOTTEST");
    await client.stop();
  });

  it("fails safely on missing DM, bot authorization, and a repeated pagination cursor", async () => {
    const { web, socket } = fakeSdk();
    web.conversations.list.mockResolvedValue({ ok: true, channels: [] });
    const client = new SocketSlackClient(config);
    await expect(client.start()).rejects.toThrow("Slack start failed");
    expect(client.status).toBe("offline");
    expect(socket.start).not.toHaveBeenCalled();
    web.auth.test.mockResolvedValue({ ok: true, user_id: "UBOT", bot_id: "BBOT" });
    await expect(client.start()).rejects.toThrow("Slack start failed");
    web.auth.test.mockResolvedValue({ ok: true, user_id: "USELFTEST" });
    web.conversations.list.mockResolvedValue({ ok: true, channels: [], response_metadata: { next_cursor: "loop" } });
    await expect(client.start()).rejects.toThrow("Slack start failed");
  });

  it("acknowledges all envelopes and forwards only valid message.im events", async () => {
    const { socket } = fakeSdk();
    const client = new SocketSlackClient(config);
    const receive = vi.fn();
    const detach = client.onMessage(receive);
    await client.start();
    const ack = vi.fn(async () => {});
    socket.emit("slack_event", { type: "events_api", ack, body: { type: "event_callback", event } });
    socket.emit("slack_event", { type: "interactive", ack, body: {} });
    socket.emit("slack_event", { type: "events_api", ack, body: {
      type: "event_callback", event: { ...event, channel_type: "channel" },
    } });
    socket.emit("slack_event", { type: "events_api", ack, body: { type: "event_callback", event: {} } });
    await flush();
    expect(ack).toHaveBeenCalledTimes(4);
    expect(receive).toHaveBeenCalledTimes(1);
    detach();
    socket.emit("slack_event", { type: "events_api", ack, body: { type: "event_callback", event } });
    await flush();
    expect(receive).toHaveBeenCalledTimes(1);
    await client.stop();
  });

  it("recognizes table-only block messages", async () => {
    const { socket } = fakeSdk();
    const client = new SocketSlackClient(config);
    const receive = vi.fn();
    client.onMessage(receive);
    await client.start();
    socket.emit("slack_event", { type: "events_api", ack: async () => {}, body: {
      type: "event_callback", event: { ...event, text: undefined, blocks: [{ type: "table", rows: [] }] },
    } });
    await flush();
    expect(receive).toHaveBeenCalledWith(expect.objectContaining({ text: "", hasTable: true }));
    await client.stop();
  });

  it("exposes reconnect/offline states without installing duplicate listeners", async () => {
    const { socket, web } = fakeSdk();
    const client = new SocketSlackClient(config);
    const statuses = vi.fn();
    client.onStatus(statuses);
    await Promise.all([client.start(), client.start()]);
    expect(socket.start).toHaveBeenCalledTimes(1);
    socket.emit("close");
    expect(client.status).toBe("reconnecting");
    await expect(client.post("offline utterance")).rejects.toThrow("Slack is offline");
    expect(web.chat.postMessage).not.toHaveBeenCalled();
    socket.emit("reconnecting");
    socket.emit("connected");
    await client.post("online utterance");
    await client.stop();
    socket.emit("connected");
    expect(client.status).toBe("offline");
    expect(statuses.mock.calls.map(([value]) => value)).toEqual(["connecting", "online", "reconnecting", "online", "offline"]);
    await client.start();
    expect(socket.listenerCount("slack_event")).toBe(1);
    await client.stop();
  });

  it("does not connect if stopped while discovering the DM", async () => {
    const { web, socket } = fakeSdk();
    let release: (value: unknown) => void = () => {};
    web.auth.test.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const client = new SocketSlackClient(config);
    const starting = client.start();
    const stopping = client.stop();
    release({ ok: true, user_id: "USELFTEST" });
    await Promise.all([starting, stopping]);
    expect(socket.start).not.toHaveBeenCalled();
    expect(client.session).toBeUndefined();
  });

  it("cleans up a stalled startup after the connection deadline", async () => {
    const { socket } = fakeSdk();
    socket.start.mockImplementation(() => new Promise(() => {}));
    const client = new SocketSlackClient(config);
    vi.useFakeTimers();
    try {
      const failure = expect(client.start()).rejects.toThrow("Slack start failed");
      await vi.advanceTimersByTimeAsync(15_000);
      await failure;
      expect(socket.disconnect).toHaveBeenCalledTimes(1);
      expect(client.status).toBe("offline");
      expect(client.session).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it("discards SDK and API error details, including tokens in string arguments", async () => {
    const { web, socket } = fakeSdk();
    const lines: string[] = [];
    const client = new SocketSlackClient(config, createLogger("debug", (line) => lines.push(line)));
    const sdkLog = constructors.socket.mock.calls[0][0].logger;
    for (const method of ["debug", "info", "warn", "error"]) sdkLog[method](config.appToken, { token: config.userToken });
    await client.start();
    web.chat.postMessage.mockRejectedValue(new Error(`private error: ${config.userToken}`));
    await expect(client.post("private speech")).rejects.toThrow(/^Slack post failed$/);
    const failedAck = vi.fn().mockRejectedValue(new Error(config.appToken));
    socket.emit("slack_event", { ack: failedAck });
    socket.emit("error", new Error(config.appToken));
    await flush();
    await client.stop();
    web.auth.test.mockRejectedValue(new Error(config.userToken));
    await expect(client.start()).rejects.toThrow(/^Slack start failed; check authorization and the existing DM configuration$/);
    expect(lines.join("\n")).not.toContain(config.userToken);
    expect(lines.join("\n")).not.toContain(config.appToken);
    expect(lines.join("\n")).not.toContain("private speech");
  });
});
