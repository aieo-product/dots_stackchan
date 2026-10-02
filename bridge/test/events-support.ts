import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { EVENT_NAMES } from "../src/events/catalog.js";
import { EventDispatcher, type DispatcherDependencies, type SubscribeRequest } from "../src/events/dispatcher.js";
import { EventStore } from "../src/events/store.js";

export const callbackUrl = "https://receiver.example.com/callback";
export const signingSecret = (): string => "whsec_" + randomBytes(32).toString("base64");
export function subscribeRequest(secret = signingSecret()): SubscribeRequest {
  return { name: "stackchan.utterance", arguments: {}, delivery: { mode: "webhook", url: callbackUrl, secret }, cursor: null };
}

export function fixture(overrides: Partial<Omit<DispatcherDependencies, "store">> = {}) {
  const directory = mkdtempSync(join(process.cwd(), ".events.local.test-"));
  const key = randomBytes(32);
  const store = new EventStore(directory, key);
  const dependencies: DispatcherDependencies = {
    store, send: new Set(EVENT_NAMES), recheckAccess: async () => true,
    post: async (_url, body) => {
      const parsed = JSON.parse(body) as { type?: string; challenge?: string };
      return { status: 200, body: JSON.stringify({ challenge: parsed.challenge }) };
    },
    ...overrides,
  };
  const dispatcher = new EventDispatcher(dependencies);
  return { directory, key, store, dependencies, dispatcher, async cleanup() {
    await dispatcher.close();
    rmSync(directory, { recursive: true, force: true });
  } };
}
