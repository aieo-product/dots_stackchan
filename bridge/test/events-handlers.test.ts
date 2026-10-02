import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createEventRegistrar, type AuthorizationRequest } from "../src/events/handlers.js";
import { createEvents } from "../src/events/index.js";
import { createMcpServer, type McpHttpServer } from "../src/mcp/server.js";
import { fixture, signingSecret, subscribeRequest } from "./events-support.js";

const fixtures: ReturnType<typeof fixture>[] = [];
const clients: Client[] = [];
const servers: McpHttpServer[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(fixtures.splice(0).map((test) => test.cleanup()));
});

async function connect(options: { principal?: string | null; allowed?: boolean; send?: Set<"stackchan.utterance" | "stackchan.touched" | "stackchan.online_changed"> } = {}) {
  const test = fixture(); fixtures.push(test);
  const authorize = vi.fn(async (context: unknown, request: AuthorizationRequest) => {
    expect(context).toBeDefined();
    expect(request.operation).toBeDefined();
    return options.principal === undefined ? "owner" : options.principal;
  });
  const registrar = createEventRegistrar({ dispatcher: test.dispatcher,
    send: options.send ?? test.dependencies.send, authorizePrincipal: authorize,
    recheckAccess: async () => options.allowed !== false,
  });
  const server = createMcpServer({
    device: { online: true, caps: { mic: true, servo: true, sanotts: true }, on() {}, send() {}, sendBinary() {} },
    listener: { nextUtterance: async () => null },
    speaker: { say: () => ({ id: "test", estimatedSeconds: 1, done: Promise.resolve() }), cancelAll() {} },
  }, registrar);
  servers.push(server);
  const address = await server.listen(0);
  const client = new Client({ name: "event-test-client", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
  clients.push(client);
  const wireResults: Record<string, unknown>[] = [];
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://${address.host}:${address.port}/mcp`), {
    fetch: async (input, init) => {
      const response = await fetch(input, init);
      if (response.headers.get("content-type")?.includes("application/json")) {
        const message = await response.clone().json() as { result?: Record<string, unknown> };
        if (message.result) wireResults.push(message.result);
      }
      return response;
    },
  }));
  const resultSchema = z.record(z.string(), z.unknown());
  return { ...test, client, authorize, wireResults, call: async (method: string, params: Record<string, unknown> = {}) => {
    const result = await client.request({ method, params }, resultSchema);
    delete result._meta;
    return result;
  } };
}

describe("MCP Events wire contract", () => {
  it("advertises events in modern discovery and lists all three complete event definitions", async () => {
    const test = await connect();
    expect(test.wireResults.find((result) => "supportedVersions" in result)).toMatchObject({
      supportedVersions: ["2026-07-28"], capabilities: { tools: {}, events: {} }, resultType: "complete",
    });
    const result = await test.call("events/list");
    const events = result.events as Record<string, unknown>[];
    expect(events.map((event) => event.name)).toEqual(["stackchan.utterance", "stackchan.touched", "stackchan.online_changed"]);
    for (const event of events) {
      expect(event).toMatchObject({ delivery: ["webhook"], inputSchema: { type: "object", additionalProperties: false }, payloadSchema: { type: "object", additionalProperties: false } });
    }
    expect(events[0].payloadSchema).toMatchObject({ required: ["text", "lang", "duration_ms"], properties: { reply_to: { type: "string" } } });
    expect((await test.client.listTools()).tools).toHaveLength(6);
    expect(test.authorize).toHaveBeenCalledWith(expect.anything(), { operation: "list" });
  });

  it("returns the specified subscription result and idempotent empty unsubscribe result", async () => {
    const test = await connect();
    const params = subscribeRequest();
    const created = await test.call("events/subscribe", { ...params, ttlMs: 10_000 });
    expect(created).toEqual({ id: expect.any(String), refreshBefore: expect.any(String), cursor: null, truncated: false });
    const refreshed = await test.call("events/subscribe", { ...params, cursor: "unsupported-replay", delivery: { ...params.delivery, secret: signingSecret() } });
    expect(refreshed.id).toBe(created.id);
    expect(refreshed.cursor).toBeNull();
    expect(test.store.subscriptions()).toHaveLength(1);
    const identity = { name: params.name, arguments: params.arguments, delivery: { mode: "webhook", url: params.delivery.url } };
    expect(await test.call("events/unsubscribe", identity)).toEqual({});
    expect(await test.call("events/unsubscribe", identity)).toEqual({});
    expect(test.store.subscriptions()).toHaveLength(0);
    expect(test.authorize).toHaveBeenCalledWith(expect.anything(), { operation: "subscribe", name: params.name, arguments: {} });
    expect(test.authorize).toHaveBeenCalledWith(expect.anything(), { operation: "unsubscribe", name: params.name, arguments: {} });
  });

  it.each([
    { name: "unknown" }, { arguments: { device_id: "unsupported-filter" } },
    { delivery: { mode: "polling" } }, { ttlMs: 0 }, { ttlMs: -1 },
    { delivery: { mode: "webhook", url: "https://receiver.example.com/", secret: "invalid" } },
  ])("rejects invalid subscriptions before authorizing or saving (%s)", async (override) => {
    const test = await connect();
    await expect(test.call("events/subscribe", { ...subscribeRequest(), ...override })).rejects.toMatchObject({ code: -32602 });
    expect(test.authorize).not.toHaveBeenCalled();
    expect(test.store.subscriptions()).toEqual([]);
  });

  it("fails closed for unauthenticated callers for every method", async () => {
    const test = await connect({ principal: null });
    for (const [method, params] of [
      ["events/list", {}], ["events/subscribe", subscribeRequest()],
      ["events/unsubscribe", { name: "stackchan.utterance", arguments: {}, delivery: { mode: "webhook", url: "https://receiver.example.com/" } }],
    ] as const) await expect(test.call(method, { ...params })).rejects.toMatchObject({ code: -32001 });
    expect(test.store.subscriptions()).toEqual([]);
  });

  it("lists only authorized enabled events and denies disabled subscriptions", async () => {
    const test = await connect({ send: new Set(["stackchan.touched"]) });
    expect(await test.call("events/list")).toMatchObject({ events: [{ name: "stackchan.touched" }] });
    await expect(test.call("events/subscribe", { ...subscribeRequest() })).rejects.toMatchObject({ code: -32001 });
    const denied = await connect({ allowed: false });
    expect(await denied.call("events/list")).toEqual({ events: [] });
    await expect(denied.call("events/subscribe", { ...subscribeRequest() })).rejects.toMatchObject({ code: -32001 });
  });

  it("does not register a service or connect the source when globally disabled", async () => {
    const source = { subscribe: vi.fn(() => () => {}) };
    const service = createEvents({ source, authorizePrincipal: async () => null, recheckAccess: async () => false },
      { enabled: false, send: new Set(), storeDir: ".events.local.unused" });
    expect(service.registrar).toBeUndefined();
    expect(service.dispatcher).toBeUndefined();
    expect(source.subscribe).not.toHaveBeenCalled();
    await service.close();
  });
});
