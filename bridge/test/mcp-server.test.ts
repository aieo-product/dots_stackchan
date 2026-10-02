import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";

import { mcpConfigSchema } from "../src/mcp/config.js";
import type {
  DeviceLink,
  DeviceMessage,
  Expression,
  Listener,
  Speaker,
  SpeechTicket,
} from "../src/mcp/dependencies.js";
import {
  createMcpServer,
  type McpHttpServer,
} from "../src/mcp/server.js";
import type { McpToolDependencies } from "../src/mcp/tools.js";
import { createNotificationCenter, type NotificationCenter } from "../src/notify/center.js";
import { notificationConfigSchema } from "../src/notify/config.js";

class FakeDevice implements DeviceLink {
  online = true;
  caps = { sanotts: true, servo: true, mic: true };
  readonly messages: DeviceMessage[] = [];
  readonly binaryMessages: Array<{
    kind: number;
    seq: number;
    data: Uint8Array;
  }> = [];
  readonly #listeners: Array<(message: unknown) => void> = [];

  send(message: DeviceMessage): void {
    this.messages.push(message);
  }

  sendBinary(kind: number, seq: number, data: Uint8Array): void {
    this.binaryMessages.push({ kind, seq, data });
  }

  on(event: "message", callback: (message: unknown) => void): void {
    if (event === "message") this.#listeners.push(callback);
  }

  emit(message: unknown): void {
    for (const listener of this.#listeners) listener(message);
  }
}

class FakeSpeaker implements Speaker {
  done: Promise<void> = Promise.resolve();
  readonly calls: Array<{
    text: string;
    options?: { expression?: Expression; interrupt?: boolean };
  }> = [];

  say(
    text: string,
    options?: { expression?: Expression; interrupt?: boolean },
  ): SpeechTicket {
    this.calls.push({ text, ...(options === undefined ? {} : { options }) });
    return {
      id: `speech-${this.calls.length}`,
      estimatedSeconds: text.length * 0.15,
      done: this.done,
    };
  }

  cancelAll(): void {}
}

class FakeListener implements Listener {
  readonly timeouts: number[] = [];
  responses: Array<{ text: string } | null> = [];

  async nextUtterance(timeoutMs: number): Promise<{ text: string } | null> {
    this.timeouts.push(timeoutMs);
    return this.responses.shift() ?? null;
  }
}

interface TestConnection {
  readonly client: Client;
  readonly endpoint: string;
}

const clients: Client[] = [];
const servers: McpHttpServer[] = [];
const centers: NotificationCenter[] = [];

afterEach(async () => {
  for (const center of centers.splice(0)) center.dispose();
  await Promise.all(clients.splice(0).map(async (client) => client.close()));
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

async function connect(
  dependencies: McpToolDependencies,
  mode: "modern" | "legacy" = "modern",
): Promise<TestConnection> {
  const server = createMcpServer(dependencies);
  servers.push(server);
  const address = await server.listen(0);
  const endpoint = `http://${address.host}:${address.port}/mcp`;
  const client = new Client(
    { name: "mcp-test-client", version: "0.0.0" },
    mode === "modern" ? { versionNegotiation: { mode: "auto" } } : undefined,
  );
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
  return { client, endpoint };
}

function createDependencies(overrides: Partial<McpToolDependencies> = {}): {
  dependencies: McpToolDependencies;
  device: FakeDevice;
  speaker: FakeSpeaker;
  listener: FakeListener;
} {
  const device = new FakeDevice();
  const speaker = new FakeSpeaker();
  const listener = new FakeListener();
  const notificationCenter = createNotificationCenter({
    device, speaker,
    config: notificationConfigSchema.parse({ QUIET_HOURS: "" }),
    log: () => {},
  });
  centers.push(notificationCenter);
  return {
    device,
    speaker,
    listener,
    dependencies: {
      device, speaker, listener,
      notificationCenter,
      ...overrides,
    },
  };
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("Expected text tool content.");
  return content.text;
}

describe("MCP server", () => {
  it("lists all six documented tools with schemas and annotations", async () => {
    const { dependencies } = createDependencies();
    const { client } = await connect(dependencies);

    const { tools } = await client.listTools();

    expect(tools.map(({ name }) => name).sort()).toEqual([
      "get_status",
      "listen",
      "look",
      "notify",
      "say",
      "set_expression",
    ]);
    for (const tool of tools) {
      expect(tool.description).toEqual(expect.any(String));
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.annotations?.destructiveHint).toBe(false);
    }
    expect(tools.find(({ name }) => name === "get_status")?.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
    });
    expect(tools.find(({ name }) => name === "say")?.annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
    });
    expect(tools.find(({ name }) => name === "say")?.inputSchema.properties?.wait).toMatchObject({
      type: "boolean",
      default: false,
    });
  });

  it("returns say and notify acknowledgements even when playback never finishes", async () => {
    const { dependencies, device, speaker } = createDependencies();
    speaker.done = new Promise(() => {});
    const { client } = await connect(dependencies);

    for (const wait of [undefined, false]) {
      const result = await client.callTool({
        name: "say",
        arguments: { text: "こんにちは", ...(wait === undefined ? {} : { wait }) },
      });
      expect(result.isError).not.toBe(true);
      expect(textOf(result)).toBe("Queued (about 1 s).");
    }
    const notification = await client.callTool({
      name: "notify",
      arguments: { message: "Reminder", topic_id: "reminder" },
    });
    expect(notification.isError).not.toBe(true);
    expect(textOf(notification)).toBe("Notification queued. topic_id: reminder");
    expect(device.messages).toEqual([{ type: "notice.pending", count: 1 }]);
    expect(speaker.calls).toHaveLength(2);
  });

  it("also supports the legacy initialize flow", async () => {
    const { dependencies } = createDependencies();
    const { client } = await connect(dependencies, "legacy");

    const { tools } = await client.listTools();

    expect(tools).toHaveLength(6);
  });

  it("runs speech, expression, head movement, and notification tools", async () => {
    const { dependencies, device, speaker } = createDependencies();
    const { client } = await connect(dependencies);

    expect(
      (
        await client.callTool({
          name: "say",
          arguments: { text: "Hello", expression: "happy", interrupt: true },
        })
      ).isError,
    ).not.toBe(true);
    await client.callTool({
      name: "set_expression",
      arguments: { expression: "doubt" },
    });
    await client.callTool({ name: "look", arguments: { pan: 25, tilt: -10 } });
    await client.callTool({
      name: "notify",
      arguments: { message: "Package arrived", priority: "high", topic_id: "delivery" },
    });

    expect(speaker.calls).toEqual([
      {
        text: "Hello",
        options: { expression: "happy", interrupt: true },
      },
      { text: "Package arrived", options: { interrupt: false } },
    ]);
    expect(device.messages).toEqual([
      { type: "face", expression: "doubt" },
      { type: "look", pan: 25, tilt: -10 },
      { type: "notice.pending", count: 1 },
      { type: "notice.pending", count: 0 },
      { type: "chime", kind: "notify" },
    ]);
  });

  it("reports validation and offline failures as tool errors", async () => {
    const { dependencies, device, speaker } = createDependencies();
    const { client } = await connect(dependencies);

    const badExpression = await client.callTool({
      name: "set_expression",
      arguments: { expression: "unknown" },
    });
    const badLook = await client.callTool({
      name: "look",
      arguments: { pan: 91, tilt: 0 },
    });
    device.online = false;
    const offline = await client.callTool({
      name: "say",
      arguments: { text: "Hello" },
    });

    expect(badExpression.isError).toBe(true);
    expect(badLook.isError).toBe(true);
    expect(offline.isError).toBe(true);
    expect(textOf(offline)).toContain("offline");
    expect(device.messages).toEqual([]);
    expect(speaker.calls).toEqual([]);
  });

  it("returns utterances, timeouts, and current status", async () => {
    let now = 10_000;
    const base = createDependencies();
    base.listener.responses.push({ text: "Good morning" }, null);
    const { client } = await connect({ ...base.dependencies, now: () => now });
    base.device.emit({ type: "state", state: "speaking" });

    const before = JSON.parse(
      textOf(await client.callTool({ name: "get_status", arguments: {} })),
    ) as Record<string, unknown>;
    const utterance = JSON.parse(
      textOf(
        await client.callTool({
          name: "listen",
          arguments: { timeout_s: 4 },
        }),
      ),
    ) as Record<string, unknown>;
    now = 12_400;
    base.device.emit({ type: "state", state: "idle" });
    const after = JSON.parse(
      textOf(await client.callTool({ name: "get_status", arguments: {} })),
    ) as Record<string, unknown>;
    const timeout = JSON.parse(
      textOf(await client.callTool({ name: "listen", arguments: {} })),
    ) as Record<string, unknown>;

    expect(before).toMatchObject({
      online: true,
      speaking: true,
      listening: false,
      last_utterance_seconds_ago: null,
    });
    expect(utterance).toEqual({ timed_out: false, text: "Good morning" });
    expect(after).toMatchObject({
      speaking: false,
      last_utterance_seconds_ago: 2,
    });
    expect(timeout).toEqual({ timed_out: true, text: null });
    expect(base.listener.timeouts).toEqual([4_000, 30_000]);
  });

  it("limits say and notify independently", async () => {
    const base = createDependencies();
    const { client } = await connect({
      ...base.dependencies,
      rateLimits: {
        say: { maxCalls: 1, windowMs: 60_000 },
        notify: { maxCalls: 1, windowMs: 60_000 },
      },
    });

    const firstSay = await client.callTool({
      name: "say",
      arguments: { text: "One" },
    });
    const secondSay = await client.callTool({
      name: "say",
      arguments: { text: "Two" },
    });
    const firstNotify = await client.callTool({
      name: "notify",
      arguments: { message: "One" },
    });
    const secondNotify = await client.callTool({
      name: "notify",
      arguments: { message: "Two" },
    });

    expect(firstSay.isError).not.toBe(true);
    expect(secondSay.isError).toBe(true);
    expect(textOf(secondSay)).toContain("Rate limit exceeded");
    expect(firstNotify.isError).not.toBe(true);
    expect(secondNotify.isError).toBe(true);
    expect(base.speaker.calls).toHaveLength(1);
    expect(base.device.messages).toContainEqual({ type: "notice.pending", count: 1 });
  });

  it("allows 20 say calls per minute by default", async () => {
    const base = createDependencies();
    const { client } = await connect(base.dependencies);

    const results = [];
    for (let index = 0; index < 21; index += 1) {
      results.push(
        await client.callTool({
          name: "say",
          arguments: { text: `Message ${index + 1}` },
        }),
      );
    }

    expect(results.slice(0, 20).every((result) => result.isError !== true)).toBe(true);
    expect(results[20]?.isError).toBe(true);
    expect(base.speaker.calls).toHaveLength(20);
  });

  it("serves only the /mcp route", async () => {
    const { dependencies } = createDependencies();
    const { endpoint } = await connect(dependencies);

    const response = await fetch(new URL("/other", endpoint));

    expect(response.status).toBe(404);
  });

  it("parses the loopback-only configuration fragment", () => {
    expect(mcpConfigSchema.parse({ MCP_PORT: "8791" })).toEqual({
      MCP_PORT: 8791,
      MCP_HOST: "127.0.0.1",
    });
    expect(() =>
      mcpConfigSchema.parse({ MCP_PORT: "8791", MCP_HOST: "0.0.0.0" }),
    ).toThrow();
  });
});
