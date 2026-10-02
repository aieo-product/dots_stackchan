import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeviceLink, Speaker } from "../src/mcp/dependencies.js";
import { createNotificationCenter, type Notification, type NotificationCenter } from "../src/notify/center.js";
import { createMcpToolRegistrar } from "../src/mcp/tools.js";
import { notificationConfigSchema } from "../src/notify/config.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

const centers: NotificationCenter[] = [];

function setup(settings: Record<string, string> = {}) {
  const callbacks: Array<(message: unknown) => void> = [];
  const device: DeviceLink = {
    online: true,
    caps: { sanotts: true, servo: true, mic: true },
    send: vi.fn(),
    sendBinary: vi.fn(),
    on: (_event, callback) => { callbacks.push(callback); },
  };
  const tickets: ReturnType<typeof deferred>[] = [];
  const speaker: Speaker = {
    say: vi.fn(() => {
      const ticket = deferred();
      tickets.push(ticket);
      return { id: `speech-${tickets.length}`, estimatedSeconds: 1, done: ticket.promise };
    }),
    cancelAll: vi.fn(),
  };
  const log = vi.fn();
  const center = createNotificationCenter({
    device, speaker, log, now: Date.now,
    config: notificationConfigSchema.parse({ QUIET_HOURS: "", ...settings }),
  });
  centers.push(center);
  const emit = (message: unknown) => { for (const callback of callbacks) callback(message); };
  const state = (value: string) => emit({ type: "state", state: value });
  const submit = (message: string, options: Partial<Notification> = {}) => center.submit({
    source: "mcp", message, priority: "normal", receivedAt: Date.now(), ...options,
  });
  const texts = () => vi.mocked(speaker.say).mock.calls.map(([text]) => text);
  const counts = () => vi.mocked(device.send).mock.calls
    .map(([message]) => message).filter((message) => message.type === "notice.pending")
    .map((message) => message.count);
  return { center, device, speaker, log, tickets, emit, state, submit, texts, counts };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 0, 15, 12));
});

afterEach(() => {
  for (const center of centers.splice(0)) center.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("notification queue", () => {
  it("routes MCP and Slack through the same center with source, timestamp and topic", async () => {
    const { center, device, speaker, submit, texts } = setup();
    const server = new McpServer({ name: "notify-test", version: "0.0.0" });
    const registration = vi.spyOn(server, "registerTool");
    const submissions = vi.spyOn(center, "submit");
    createMcpToolRegistrar({
      device, speaker, notificationCenter: center, now: Date.now,
      listener: { nextUtterance: async () => null },
    }).register(server);
    const handler = registration.mock.calls.find(([tool]) => tool === "notify")?.[2];
    if (handler === undefined) throw new Error("Missing notify tool.");
    const call = handler as unknown as (input: Record<string, unknown>) => CallToolResult;
    const result = call({ message: "Reminder", priority: "high", topic_id: "reminder" });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Notification queued. topic_id: reminder" }]);
    expect(submissions).toHaveBeenCalledWith({
      source: "mcp", message: "Reminder", priority: "high", topicId: "reminder", receivedAt: Date.now(),
    });
    expect(submit("Reminder", { source: "slack" })).toBe("duplicate");
    expect(texts()).toEqual(["Reminder"]);
    await server.close();
  });

  it("deduplicates normalized messages across MCP and Slack without extending the window", async () => {
    const { submit, center, texts } = setup();
    expect(submit(" Ａ reminder\n ready ")).toBe("queued");
    await vi.advanceTimersByTimeAsync(599_999);
    expect(submit("A reminder ready", { source: "slack" })).toBe("duplicate");
    expect(center.pendingCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(submit("A reminder ready", { source: "slack" })).toBe("queued");
    expect(center.pendingCount).toBe(1);
    expect(texts()).toEqual([" Ａ reminder\n ready "]);
  });

  it("uses actual arrival time for dedup even when source timestamps are delayed", () => {
    const { submit } = setup();
    submit("Reminder", { receivedAt: Date.now() - 600_000 });
    expect(submit("Reminder", { source: "slack" })).toBe("duplicate");
  });

  it("supports configurable and disabled dedup windows", async () => {
    const configured = setup({ NOTIFY_DEDUP_WINDOW_S: "1" });
    configured.submit("Reminder");
    expect(configured.submit("Reminder")).toBe("duplicate");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(configured.submit("Reminder")).toBe("queued");
    const disabled = setup({ NOTIFY_DEDUP_WINDOW_S: "0" });
    expect(disabled.submit("Reminder")).toBe("queued");
    expect(disabled.submit("Reminder")).toBe("queued");
  });

  it.each(["listening", "thinking", "speaking"])("waits until %s ends and then for two uninterrupted idle seconds", async (busy) => {
    const { state, submit, texts } = setup();
    state(busy);
    submit("Reminder");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(texts()).toEqual([]);
    state("idle");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(texts()).toEqual([]);
    state(busy);
    await vi.advanceTimersByTimeAsync(1);
    expect(texts()).toEqual([]);
    state("idle");
    await vi.advanceTimersByTimeAsync(1_000);
    state("idle"); // Repeated idle reports must not postpone playback.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(texts()).toEqual(["Reminder"]);
  });

  it("prioritizes high after current device speech without interrupting; preserves FIFO within each priority", async () => {
    const { state, submit, texts, tickets, speaker } = setup();
    state("speaking");
    submit("Normal one");
    submit("High one", { priority: "high" });
    submit("High two", { priority: "high" });
    submit("Normal two");
    expect(texts()).toEqual([]);
    state("idle");
    expect(texts()).toEqual(["High one"]);
    expect(speaker.say).toHaveBeenLastCalledWith("High one", { interrupt: false });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(texts()).toEqual(["High one"]);
    tickets[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(texts()).toEqual(["High one", "High two"]);
    tickets[1].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(texts()).toEqual(["High one", "High two", "Normal one"]);
    tickets[2].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(texts()).toEqual(["High one", "High two", "Normal one", "Normal two"]);
  });

  it("waits for its own speech ticket before chiming for a later notification", async () => {
    const { submit, texts, tickets, device, speaker } = setup();
    submit("First", { priority: "high" });
    submit("Second", { priority: "high" });
    expect(texts()).toEqual(["First"]);
    expect(vi.mocked(device.send).mock.calls.filter(([message]) => message.type === "chime")).toHaveLength(1);
    tickets[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(texts()).toEqual(["First", "Second"]);
    const chimes = vi.mocked(device.send).mock.calls.flatMap(([message], index) =>
      message.type === "chime" ? [vi.mocked(device.send).mock.invocationCallOrder[index]] : []);
    expect(chimes[1]).toBeLessThan(vi.mocked(speaker.say).mock.invocationCallOrder[1]);
  });

  it("isolates sync and async playback errors and keeps notification bodies out of error logs", async () => {
    const { submit, texts, tickets, speaker, center, log } = setup();
    vi.mocked(speaker.say).mockImplementationOnce(() => { throw new Error("Private notification body"); });
    expect(submit("Private notification body", { priority: "high", topicId: "failed" })).toBe("queued");
    expect(center.context.forUtterance()).toBeUndefined();
    submit("Other body", { priority: "high", topicId: "other" });
    submit("Next", { priority: "high", topicId: "next" });
    tickets[0].reject(new Error("Other body"));
    await vi.advanceTimersByTimeAsync(0);
    expect(texts()).toEqual(["Private notification body", "Other body", "Next"]);
    expect(center.context.forUtterance()).toBeUndefined();
    expect(log.mock.calls.filter(([entry]) => entry.event === "failed")).toHaveLength(2);
    expect(JSON.stringify(log.mock.calls)).not.toContain("body");
  });

  it("records context at successful playback completion, not queue time", async () => {
    const { submit, tickets, center } = setup();
    submit("Reminder", { priority: "high", topicId: "reminder" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(center.context.forUtterance()).toBeUndefined();
    tickets[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(center.context.forUtterance()).toEqual({ reply_to: "reminder" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(center.context.forUtterance()).toEqual({ reply_to: "reminder" });
    await vi.advanceTimersByTimeAsync(1);
    expect(center.context.forUtterance()).toBeUndefined();
  });

  it("redacts bodies by default and includes them only with explicit logging enabled", () => {
    const redacted = setup();
    redacted.submit("Notification body");
    redacted.submit("Notification body", { source: "slack" });
    expect(redacted.log.mock.calls).toEqual([
      [{ event: "queued", source: "mcp", priority: "normal" }],
      [{ event: "duplicate", source: "slack", priority: "normal" }],
    ]);
    const enabled = setup({ LOG_NOTIFICATIONS: "true" });
    enabled.submit("Notification body");
    expect(enabled.log).toHaveBeenCalledWith({
      event: "queued", source: "mcp", priority: "normal", message: "Notification body",
    });
  });

  it("does not allow logger or unread-display failures to break delivery", () => {
    const { log, device, submit, texts } = setup();
    log.mockImplementation(() => { throw new Error("Log unavailable"); });
    vi.mocked(device.send).mockImplementationOnce(() => { throw new Error("Device unavailable"); });
    expect(submit("Reminder", { priority: "high" })).toBe("queued");
    expect(texts()).toEqual(["Reminder"]);
  });

  it("retains offline notifications and resumes on a device state event", async () => {
    const { device, emit, state, submit, texts, counts } = setup();
    Object.assign(device, { online: false });
    emit({ type: "state", state: "idle" });
    submit("Reminder");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(texts()).toEqual([]);
    Object.assign(device, { online: true });
    state("idle");
    expect(texts()).toEqual(["Reminder"]);
    expect(counts()).toEqual([1, 0]);
  });

  it("validates notifications and ignores malformed device messages", async () => {
    const { submit, emit, texts } = setup();
    expect(() => submit(" \n ")).toThrow();
    expect(() => submit("Reminder", { receivedAt: NaN })).toThrow();
    submit("Reminder");
    for (const message of [null, "state", {}, { type: "state", state: 3 }, { type: "event", kind: "other" }]) emit(message);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(texts()).toEqual(["Reminder"]);
  });

  it("disposes timers and ignores subsequent device events and ticket completion", async () => {
    const { submit, center, emit, texts } = setup();
    submit("Reminder");
    center.dispose();
    emit({ type: "event", kind: "touch" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(texts()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => submit("Other")).toThrow("disposed");
    const playing = setup();
    playing.submit("Active", { priority: "high", topicId: "active" });
    playing.submit("Waiting", { priority: "high" });
    playing.center.dispose();
    playing.tickets[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(playing.texts()).toEqual(["Active"]);
    expect(playing.center.context.forUtterance()).toBeUndefined();
  });
});

describe("quiet notification delivery", () => {
  it.each([
    [new Date(2026, 0, 15, 21, 59, 59), new Date(2026, 0, 16, 7), "22:00-07:00"],
    [new Date(2026, 0, 15, 12), new Date(2026, 0, 15, 13), "12:00-13:00"],
  ])("holds normal and high notifications until the local quiet end (%s)", async (start, end, hours) => {
    vi.setSystemTime(start);
    const { submit, texts, counts, tickets, center } = setup({ QUIET_HOURS: hours });
    // In the overnight case the normal idle delay crosses into quiet hours.
    submit("Normal");
    await vi.advanceTimersByTimeAsync(1_000);
    submit("High", { priority: "high" });
    expect(texts()).toEqual([]);
    expect(center.pendingCount).toBe(2);
    const remaining = end.getTime() - Date.now();
    await vi.advanceTimersByTimeAsync(remaining - 1);
    expect(texts()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(texts()).toEqual(["High"]);
    tickets[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(texts()).toEqual(["High", "Normal"]);
    expect(counts()).toEqual([1, 2, 1, 0]);
  });

  it("touch releases the current backlog, but later arrivals remain quiet", async () => {
    vi.setSystemTime(new Date(2026, 0, 15, 23));
    const { submit, emit, texts, tickets, center } = setup({ QUIET_HOURS: "22:00-07:00" });
    submit("First");
    submit("Second");
    await vi.advanceTimersByTimeAsync(2_000);
    emit({ type: "event", kind: "other" });
    expect(texts()).toEqual([]);
    emit({ type: "event", kind: "touch" });
    expect(texts()).toEqual(["First"]);
    submit("Later", { priority: "high" });
    tickets[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(texts()).toEqual(["First", "Second"]);
    tickets[1].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(center.pendingCount).toBe(1);
    expect(texts()).toEqual(["First", "Second"]);
  });

  it("allows only high priority through quiet hours when configured", async () => {
    vi.setSystemTime(new Date(2026, 0, 15, 23));
    const { submit, texts, center } = setup({ QUIET_HOURS: "22:00-07:00", QUIET_ALLOW_HIGH: "true" });
    submit("Normal");
    submit("High", { priority: "high" });
    expect(texts()).toEqual(["High"]);
    expect(center.pendingCount).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(texts()).toEqual(["High"]);
  });
});
