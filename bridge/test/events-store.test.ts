import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { readEventsConfig } from "../src/events/config.js";
import { decodeKey, validSigningSecret } from "../src/events/crypto.js";
import { EventStore } from "../src/events/store.js";
import { canonicalJson, subscriptionId } from "../src/events/dispatcher.js";
import { EVENT_NAMES } from "../src/events/catalog.js";
import { fixture, signingSecret, subscribeRequest } from "./events-support.js";

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((test) => test.cleanup())); });
function setup() { const test = fixture(); fixtures.push(test); return test; }

describe("event configuration and identity", () => {
  it("defaults on and requires an injected 32-byte encryption key", () => {
    const key = randomBytes(32);
    expect(readEventsConfig({ EVENTS_SECRET_KEY: key.toString("base64") })).toEqual({
      enabled: true, send: new Set(EVENT_NAMES), secretKey: key, storeDir: ".events.local.data",
    });
    expect(() => readEventsConfig({})).toThrow("EVENTS_SECRET_KEY");
    expect(() => readEventsConfig({ EVENTS_SECRET_KEY: "invalid" })).toThrow();
  });

  it("disables all events without needing secrets and supports per-event opt-out", () => {
    expect(readEventsConfig({ EVENTS_ENABLED: "false" }).secretKey).toBeUndefined();
    expect(readEventsConfig({ EVENTS_ENABLED: "false", EVENTS_SEND: "" }).send.size).toBe(0);
    expect(readEventsConfig({ EVENTS_ENABLED: "false", EVENTS_SEND: "stackchan.touched" }).send).toEqual(new Set(["stackchan.touched"]));
    expect(() => readEventsConfig({ EVENTS_ENABLED: "no" })).toThrow();
    expect(() => readEventsConfig({ EVENTS_ENABLED: "false", EVENTS_SEND: "unknown" })).toThrow();
  });

  it("accepts only canonical base64 signing keys of 24–64 bytes", () => {
    for (const size of [24, 32, 64]) expect(validSigningSecret("whsec_" + randomBytes(size).toString("base64"))).toBe(true);
    for (const size of [0, 23, 65]) expect(validSigningSecret("whsec_" + randomBytes(size).toString("base64"))).toBe(false);
    expect(validSigningSecret("whsec_" + "!".repeat(32))).toBe(false);
    expect(validSigningSecret(randomBytes(32).toString("base64"))).toBe(false);
    expect(() => decodeKey(randomBytes(31).toString("base64"), 32)).toThrow();
  });

  it("canonicalizes nested arguments and isolates identity by principal, URL, and event", () => {
    expect(canonicalJson({ b: [{ z: 2, a: 1 }], a: true })).toBe(canonicalJson({ a: true, b: [{ a: 1, z: 2 }] }));
    const params = subscribeRequest();
    const id = subscriptionId("owner", params);
    const rotated = { ...params, delivery: { ...params.delivery, secret: signingSecret() } };
    expect(subscriptionId("owner", rotated)).toBe(id);
    expect(subscriptionId("other", params)).not.toBe(id);
    expect(subscriptionId("owner", { ...params, name: "stackchan.touched" })).not.toBe(id);
    expect(subscriptionId("owner", { ...params, delivery: { ...params.delivery, url: params.delivery.url + "/other" } })).not.toBe(id);
  });
});

describe("encrypted event store", () => {
  it("restores subscriptions, rotation keys and failed deliveries with private permissions", async () => {
    const test = setup();
    const params = subscribeRequest();
    const { id } = await test.dispatcher.subscribe("owner", params);
    const previousSecret = params.delivery.secret;
    const nextSecret = signingSecret();
    await test.dispatcher.subscribe("owner", { ...params, delivery: { ...params.delivery, secret: nextSecret } });
    test.store.savePending({ id: "pending-test", subscriptionId: id, body: "synthetic transcript", attempts: 1, nextAttemptAt: Date.now() + 1_000 });
    const file = join(test.directory, "events.json");
    const contents = readFileSync(file, "utf8");
    expect(contents).not.toContain(previousSecret);
    expect(contents).not.toContain(nextSecret);
    expect(contents).not.toContain("synthetic transcript");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(test.directory).mode & 0o777).toBe(0o700);
    const restored = new EventStore(test.directory, test.key);
    expect(restored.get(id)).toMatchObject({ secret: nextSecret, previousSecret });
    expect(restored.pending()).toEqual(test.store.pending());
    restored.remove(id);
    expect(restored.pending()).toEqual([]);
    expect(new EventStore(test.directory, test.key).subscriptions()).toEqual([]);
  });

  it("fails closed on wrong keys and damaged ciphertext", async () => {
    const test = setup();
    await test.dispatcher.subscribe("owner", subscribeRequest());
    expect(() => new EventStore(test.directory, randomBytes(32))).toThrow("cannot be decrypted");
    const file = join(test.directory, "events.json");
    const state = JSON.parse(readFileSync(file, "utf8")) as { subscriptions: { secret: string }[] };
    state.subscriptions[0].secret = randomBytes(48).toString("base64");
    writeFileSync(file, JSON.stringify(state));
    expect(() => new EventStore(test.directory, test.key)).toThrow("cannot be decrypted");
  });

  it("returns snapshots so callers cannot mutate persisted ownership", async () => {
    const test = setup();
    const { id } = await test.dispatcher.subscribe("owner", subscribeRequest());
    const snapshot = test.store.get(id);
    if (snapshot) snapshot.principalId = "other";
    expect(test.store.get(id)?.principalId).toBe("owner");
  });
});
