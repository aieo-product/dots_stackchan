import { randomBytes } from "node:crypto";
import { Webhook } from "standardwebhooks";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EVENT_NAMES, type SourceEvent } from "../src/events/catalog.js";
import { CallbackError } from "../src/events/destination.js";
import { EventDispatcher, MAX_EVENT_BYTES, RETRY_DELAYS_MS, type DispatcherDependencies } from "../src/events/dispatcher.js";
import { EventStore } from "../src/events/store.js";
import { fixture, signingSecret, subscribeRequest } from "./events-support.js";

const fixtures: ReturnType<typeof fixture>[] = [];
const extraDispatchers: EventDispatcher[] = [];
afterEach(async () => {
  await Promise.all(extraDispatchers.splice(0).map((dispatcher) => dispatcher.close()));
  await Promise.all(fixtures.splice(0).map((test) => test.cleanup()));
  vi.useRealTimers();
});
function setup(overrides: Partial<Omit<DispatcherDependencies, "store">> = {}) {
  const test = fixture(overrides); fixtures.push(test); return test;
}
const utterance: SourceEvent = { name: "stackchan.utterance", data: { text: "こんにちは、スタックちゃん", lang: "ja", duration_ms: 1_200, reply_to: "test-topic" } };

describe("verification and signed events", () => {
  it("verifies the callback, delivers exactly one event, and stops on 410", async () => {
    const params = subscribeRequest();
    const received: { eventId?: string; type?: string; challenge?: string; name?: string }[] = [];
    let deliveryStatus = 200;
    let subscriptionHeader = "";
    const test = setup({ post: async (_url, body, headers) => {
      const event = new Webhook(params.delivery.secret).verify(body, headers) as typeof received[number];
      received.push(event);
      subscriptionHeader = headers["X-MCP-Subscription-Id"];
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["webhook-id"]).toBe(event.eventId ?? headers["webhook-id"]);
      return { status: event.type === "verification" ? 200 : deliveryStatus, body: JSON.stringify({ challenge: event.challenge }) };
    } });
    const result = await test.dispatcher.subscribe("owner", params);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ type: "verification", challenge: expect.any(String) });
    await test.dispatcher.publish(utterance);
    expect(received).toHaveLength(2);
    expect(received[1]).toEqual({ eventId: expect.any(String), name: utterance.name,
      timestamp: expect.any(String), data: utterance.data, cursor: null });
    expect(received[1]).not.toHaveProperty("type");
    expect(subscriptionHeader).toBe(result.id);
    deliveryStatus = 410;
    await test.dispatcher.publish(utterance);
    expect(test.store.subscriptions()).toEqual([]);
    await test.dispatcher.publish(utterance);
    expect(received).toHaveLength(3);
    expect(test.store.pending()).toEqual([]);
  });

  it.each([
    { status: 200, body: JSON.stringify({ challenge: "wrong" }) },
    { status: 204, body: "" }, { status: 500, body: "{}" }, { status: 302, body: "{}" },
  ])("refuses application delivery after failed verification (%s)", async (response) => {
    const post = vi.fn(async () => response);
    const test = setup({ post });
    await expect(test.dispatcher.subscribe("owner", subscribeRequest())).rejects.toMatchObject({ code: -32015,
      data: { reason: response.status === 302 ? "redirect" : "challenge_failed" } });
    expect(test.store.subscriptions()).toEqual([]);
    await test.dispatcher.publish(utterance);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it.each(["non_public_address", "timeout", "redirect"] as const)("categorizes callback transport rejection: %s", async (reason) => {
    const test = setup({ post: async () => { throw new CallbackError(reason); } });
    await expect(test.dispatcher.subscribe("owner", subscribeRequest())).rejects.toMatchObject({ code: -32015, data: { reason } });
  });

  it("uses bounded principal/URL verification caching, fresh challenges, and idempotent identities", async () => {
    vi.useFakeTimers();
    const challenges: string[] = [];
    const post = vi.fn(async (_url: string, body: string) => {
      const { challenge } = JSON.parse(body) as { challenge: string };
      challenges.push(challenge);
      return { status: 200, body: JSON.stringify({ challenge }) };
    });
    const test = setup({ post });
    const params = subscribeRequest();
    const results = await Promise.all([test.dispatcher.subscribe("owner", params), test.dispatcher.subscribe("owner", params)]);
    expect(results[0].id).toBe(results[1].id);
    expect(test.store.subscriptions()).toHaveLength(1);
    await test.dispatcher.subscribe("owner", { ...params, name: "stackchan.touched" });
    expect(post).toHaveBeenCalledTimes(1);
    await test.dispatcher.subscribe("other", params);
    expect(post).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
    await test.dispatcher.subscribe("owner", params);
    expect(post).toHaveBeenCalledTimes(3);
    expect(new Set(challenges).size).toBe(3);
  });

  it("signs with old and new keys during rotation and only the new key after it", async () => {
    vi.useFakeTimers();
    const old = signingSecret();
    const next = signingSecret();
    const records: { body: string; headers: Record<string, string> }[] = [];
    const test = setup({ post: async (_url, body, headers) => {
      const event = JSON.parse(body) as { challenge?: string; type?: string };
      if (!event.type) records.push({ body, headers });
      return { status: 200, body: JSON.stringify({ challenge: event.challenge }) };
    } });
    await test.dispatcher.subscribe("owner", subscribeRequest(old));
    await test.dispatcher.subscribe("owner", subscribeRequest(next));
    await test.dispatcher.publish(utterance);
    for (const key of [old, next]) expect(() => new Webhook(key).verify(records[0].body, records[0].headers)).not.toThrow();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1_000);
    await test.dispatcher.publish(utterance);
    expect(() => new Webhook(old).verify(records[1].body, records[1].headers)).toThrow();
    expect(() => new Webhook(next).verify(records[1].body, records[1].headers)).not.toThrow();
  });

  it("requires valid secrets and access before even contacting the callback", async () => {
    const post = vi.fn();
    const test = setup({ post, recheckAccess: async () => false });
    await expect(test.dispatcher.subscribe("owner", subscribeRequest())).rejects.toMatchObject({ code: -32001 });
    await expect(test.dispatcher.subscribe("owner", subscribeRequest(randomBytes(32).toString("base64")))).rejects.toMatchObject({ code: -32602 });
    expect(post).not.toHaveBeenCalled();
  });
});

describe("delivery retries, lifetime and privacy controls", () => {
  function failingReceiver(status = 503) {
    const calls: { body: string; headers: Record<string, string>; at: number }[] = [];
    const test = setup({ post: async (_url, body, headers) => {
      const event = JSON.parse(body) as { type?: string; challenge?: string };
      if (event.type === "verification") return { status: 200, body: JSON.stringify({ challenge: event.challenge }) };
      calls.push({ body, headers, at: Date.now() });
      return { status, body: "" };
    } });
    return { test, calls };
  }

  it("retries five times with exponential backoff and stable IDs but fresh signatures", async () => {
    vi.useFakeTimers();
    const { test, calls } = failingReceiver();
    const params = subscribeRequest();
    await test.dispatcher.subscribe("owner", params);
    await test.dispatcher.publish(utterance);
    expect(calls).toHaveLength(1);
    for (const delay of RETRY_DELAYS_MS) {
      const count = calls.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(calls).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(count + 1);
    }
    expect(calls).toHaveLength(6);
    expect(new Set(calls.map(({ body }) => body)).size).toBe(1);
    expect(new Set(calls.map(({ headers }) => headers["webhook-id"])).size).toBe(1);
    expect(new Set(calls.map(({ headers }) => headers["webhook-signature"])).size).toBe(6);
    for (const { body, headers } of calls) {
      vi.setSystemTime(Number(headers["webhook-timestamp"]) * 1_000);
      expect(() => new Webhook(params.delivery.secret).verify(body, headers)).not.toThrow();
    }
    expect(test.store.pending()).toEqual([]);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(calls).toHaveLength(6);
  });

  it.each([413, 400, 401, 302])("does not retry terminal HTTP status %s", async (status) => {
    vi.useFakeTimers();
    const { test, calls } = failingReceiver(status);
    await test.dispatcher.subscribe("owner", subscribeRequest());
    await test.dispatcher.publish(utterance);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(calls).toHaveLength(1);
    expect(test.store.pending()).toEqual([]);
    expect(test.store.subscriptions()).toHaveLength(1);
  });

  it.each([408, 429])("retries transient HTTP status %s", async (status) => {
    vi.useFakeTimers();
    const { test, calls } = failingReceiver(status);
    await test.dispatcher.subscribe("owner", subscribeRequest());
    await test.dispatcher.publish(utterance);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(2);
  });

  it("restores failed deliveries across restart without resetting attempts or event IDs", async () => {
    vi.useFakeTimers();
    const { test, calls } = failingReceiver();
    const params = subscribeRequest();
    await test.dispatcher.subscribe("owner", params);
    await test.dispatcher.publish(utterance);
    await test.dispatcher.close();
    const restoredStore = new EventStore(test.directory, test.key);
    const restored = new EventDispatcher({ ...test.dependencies, store: restoredStore });
    extraDispatchers.push(restored);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(2);
    expect(calls[1].body).toBe(calls[0].body);
    expect(restoredStore.pending()[0].attempts).toBe(2);
    expect(restoredStore.subscriptions()).toHaveLength(1);
  });

  it("cancels pending retries on unsubscribe and isolates other owners", async () => {
    vi.useFakeTimers();
    const { test, calls } = failingReceiver();
    const params = subscribeRequest();
    await test.dispatcher.subscribe("owner", params);
    await test.dispatcher.unsubscribe("other", params);
    expect(test.store.subscriptions()).toHaveLength(1);
    await test.dispatcher.publish(utterance);
    expect(test.store.pending()).toHaveLength(1);
    expect(await test.dispatcher.unsubscribe("owner", params)).toEqual({});
    expect(await test.dispatcher.unsubscribe("owner", params)).toEqual({});
    await vi.advanceTimersByTimeAsync(100_000);
    expect(calls).toHaveLength(1);
    expect(test.store.pending()).toEqual([]);
  });

  it("grants finite TTLs, refreshes idempotently, and stops when expiration passes", async () => {
    vi.useFakeTimers();
    const { test, calls } = failingReceiver();
    const params = { ...subscribeRequest(), ttlMs: 500 };
    const before = await test.dispatcher.subscribe("owner", params);
    expect(Date.parse(before.refreshBefore) - Date.now()).toBe(500);
    await vi.advanceTimersByTimeAsync(250);
    const refreshed = await test.dispatcher.subscribe("owner", params);
    expect(refreshed.id).toBe(before.id);
    expect(Date.parse(refreshed.refreshBefore) - Date.now()).toBe(500);
    await test.dispatcher.publish(utterance);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(1);
    expect(test.store.subscriptions()).toEqual([]);
    const finite = await test.dispatcher.subscribe("owner", { ...params, ttlMs: null });
    expect(typeof finite.refreshBefore).toBe("string");
    expect(Date.parse(finite.refreshBefore) - Date.now()).toBe(24 * 60 * 60 * 1_000);
  });

  it("stops a pending retry if access is revoked", async () => {
    vi.useFakeTimers();
    let allowed = true;
    let delivered = 0;
    const test = setup({ recheckAccess: async () => allowed, post: async (_url, body) => {
      const event = JSON.parse(body) as { challenge?: string; type?: string };
      if (!event.type) delivered++;
      return { status: event.type ? 200 : 503, body: JSON.stringify({ challenge: event.challenge }) };
    } });
    await test.dispatcher.subscribe("owner", subscribeRequest());
    await test.dispatcher.publish(utterance);
    allowed = false;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(delivered).toBe(1);
    expect(test.store.subscriptions()).toEqual([]);
    expect(test.store.pending()).toEqual([]);
  });

  it("checks unsubscribe again after an asynchronous authorization check", async () => {
    let release: ((value: boolean) => void) | undefined;
    let block = false;
    const post = vi.fn(async (_url: string, body: string) => ({ status: 200, body: JSON.stringify({ challenge: (JSON.parse(body) as { challenge?: string }).challenge }) }));
    const test = setup({ post, recheckAccess: () => block ? new Promise<boolean>((resolve) => { release = resolve; }) : Promise.resolve(true) });
    const params = subscribeRequest();
    await test.dispatcher.subscribe("owner", params);
    block = true;
    const publishing = test.dispatcher.publish(utterance);
    await test.dispatcher.unsubscribe("owner", params);
    release?.(true);
    await publishing;
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("removes a subscription if it expires during an asynchronous access check", async () => {
    vi.useFakeTimers();
    let release: ((value: boolean) => void) | undefined;
    let block = false;
    const post = vi.fn(async (_url: string, body: string) => ({ status: 200, body: JSON.stringify({ challenge: (JSON.parse(body) as { challenge?: string }).challenge }) }));
    const test = setup({ post, recheckAccess: () => block ? new Promise<boolean>((resolve) => { release = resolve; }) : Promise.resolve(true) });
    await test.dispatcher.subscribe("owner", { ...subscribeRequest(), ttlMs: 500 });
    block = true;
    const publishing = test.dispatcher.publish(utterance);
    await vi.advanceTimersByTimeAsync(500);
    release?.(true);
    await publishing;
    expect(post).toHaveBeenCalledTimes(1);
    expect(test.store.subscriptions()).toEqual([]);
  });

  it("validates payloads and counts UTF-8 bytes including the event envelope", async () => {
    const test = setup();
    await expect(test.dispatcher.publish({ ...utterance, data: { text: "", lang: "ja", duration_ms: -1 } })).rejects.toThrow();
    await expect(test.dispatcher.publish({ ...utterance, timestamp: "no timezone" })).rejects.toThrow();
    await expect(test.dispatcher.publish({ ...utterance, data: { ...utterance.data, text: "あ".repeat(MAX_EVENT_BYTES / 2) } })).rejects.toThrow("256 KiB");
  });

  it("connects the injected source once, applies opt-out, and detaches on close", async () => {
    let listener: ((event: SourceEvent) => void) | undefined;
    const disconnect = vi.fn();
    const subscribe = vi.fn((callback: (event: SourceEvent) => void) => { listener = callback; return disconnect; });
    const delivered: unknown[] = [];
    const test = setup({ source: { subscribe }, send: new Set(["stackchan.touched"]), post: async (_url, body) => {
      const event = JSON.parse(body) as { challenge?: string; type?: string };
      if (!event.type) delivered.push(event);
      return { status: 200, body: JSON.stringify({ challenge: event.challenge }) };
    } });
    await test.dispatcher.subscribe("owner", { ...subscribeRequest(), name: "stackchan.touched" });
    listener?.(utterance);
    listener?.({ name: "stackchan.touched", data: { where: "head" } });
    await vi.waitFor(() => expect(delivered).toHaveLength(1));
    await test.dispatcher.close();
    expect(delivered).toHaveLength(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    listener?.({ name: "stackchan.touched", data: { where: "head" } });
    expect(delivered).toHaveLength(1);
    expect(new Set(EVENT_NAMES).size).toBe(3);
  });
});
