import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeviceLink, Speaker } from "../src/mcp/dependencies.js";
import { createMcpToolRegistrar } from "../src/mcp/tools.js";
import { createNotificationCenter, type NotificationCenter } from "../src/notify/center.js";
import { notificationConfigSchema } from "../src/notify/config.js";

const centers: NotificationCenter[] = [];

function deferred() {
  let resolve: () => void = () => {};
  let reject: (reason: Error) => void = () => {};
  const promise = new Promise<void>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

function setup(done: Promise<void>) {
  const device: DeviceLink = {
    online: true,
    caps: { sanotts: true, servo: true, mic: true },
    send: vi.fn(),
    sendBinary: vi.fn(),
    on: vi.fn(),
  };
  const speaker: Speaker = {
    say: vi.fn((text: string) => ({
      id: "speech-1",
      estimatedSeconds: text.length * 0.15,
      done,
    })),
    cancelAll: vi.fn(),
  };
  const server = new McpServer({ name: "speech-test", version: "0.0.0" });
  const registration = vi.spyOn(server, "registerTool");
  const notificationCenter = createNotificationCenter({
    device, speaker,
    config: notificationConfigSchema.parse({ QUIET_HOURS: "" }),
    log: () => {},
  });
  centers.push(notificationCenter);
  createMcpToolRegistrar({
    notificationCenter,
    device,
    speaker,
    listener: { nextUtterance: async () => null },
  }).register(server);

  function call(name: string, args: Record<string, unknown> = {}) {
    const handler = registration.mock.calls.find(([tool]) => tool === name)?.[2];
    if (handler === undefined) throw new Error(`Missing tool: ${name}`);
    return (handler as unknown as (
      input: Record<string, unknown>,
    ) => CallToolResult | Promise<CallToolResult>)(args);
  }
  return { device, speaker, call };
}

function textOf(result: CallToolResult): string {
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Expected text tool content.");
  return content.text;
}

afterEach(() => {
  for (const center of centers.splice(0)) center.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("speech playback lifecycle", () => {
  it("waits for completion when requested and clears the timeout", async () => {
    vi.useFakeTimers();
    const { promise, resolve } = deferred();
    const { call } = setup(promise);
    const result = call("say", { text: "Hello", wait: true });
    let returned = false;
    void Promise.resolve(result).then(() => { returned = true; });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(returned).toBe(false);
    expect(textOf(await call("get_status"))).toContain('"speaking":true');
    resolve();
    expect(textOf(await result)).toBe("Stack-chan spoke the text.");
    expect(textOf(await call("get_status"))).toContain('"speaking":false');
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps waiting at 60 seconds while playback continues", async () => {
    vi.useFakeTimers();
    const { promise, resolve } = deferred();
    const { call } = setup(promise);
    const result = call("say", { text: "Hello", wait: true });
    let returned = false;
    void Promise.resolve(result).then(() => { returned = true; });

    await vi.advanceTimersByTimeAsync(59_999);
    expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(textOf(await result)).toBe("Stack-chan is still speaking.");
    expect(textOf(await call("get_status"))).toContain('"speaking":true');
    expect(vi.getTimerCount()).toBe(0);
    resolve();
    await promise;
    expect(textOf(await call("get_status"))).toContain('"speaking":false');
  });

  it("returns a tool error on playback failure or cancellation when waiting", async () => {
    vi.useFakeTimers();
    const { promise, reject } = deferred();
    const { call } = setup(promise);
    const result = call("say", { text: "Hello", wait: true });

    reject(new Error("Playback cancelled"));
    expect((await result).isError).toBe(true);
    expect(textOf(await call("get_status"))).toContain('"speaking":false');
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles a later playback rejection after an immediate acknowledgement", async () => {
    const { promise, reject } = deferred();
    const { call } = setup(promise);

    expect(textOf(await call("say", { text: "Hello", wait: false }))).toContain("Queued");
    expect(textOf(await call("get_status"))).toContain('"speaking":true');
    reject(new Error("Playback failed"));
    await promise.catch(() => {});
    expect(textOf(await call("get_status"))).toContain('"speaking":false');
  });

  it("reports say enqueue failures while accepting notifications for later delivery", async () => {
    const { speaker, call } = setup(Promise.resolve());
    vi.mocked(speaker.say).mockImplementation(() => { throw new Error("Queue unavailable"); });

    expect((await call("say", { text: "Hello" })).isError).toBe(true);
    expect((await call("notify", { message: "Reminder" })).isError).not.toBe(true);
    expect(textOf(await call("get_status"))).toContain('"speaking":false');
  });
});
