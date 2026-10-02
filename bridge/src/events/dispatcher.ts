import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { ProtocolError } from "@modelcontextprotocol/server";
import { Webhook } from "standardwebhooks";
import { z } from "zod";

import { type EventName, type SourceEvent, payloadSchemas } from "./catalog.js";
import { validSigningSecret } from "./crypto.js";
import { CallbackError, createWebhookPost, type WebhookPost } from "./destination.js";
import { EventStore, type PendingDelivery, type Subscription } from "./store.js";

export const MAX_EVENT_BYTES = 256 * 1024;
export const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
const LIFETIME_MS = 24 * 60 * 60 * 1_000;
const VERIFICATION_CACHE_MS = 5 * 60 * 1_000;
const ROTATION_MS = 5 * 60 * 1_000;

export interface SubscriptionIdentity {
  name: EventName;
  arguments: Record<string, never>;
  delivery: { mode: "webhook"; url: string };
}
export interface SubscribeRequest extends SubscriptionIdentity {
  delivery: SubscriptionIdentity["delivery"] & { secret: string };
  ttlMs?: number | null;
  cursor?: string | null;
}
export interface SubscriptionResult {
  id: string;
  refreshBefore: string;
  cursor: null;
  truncated: false;
}
export type RecheckAccess = (principalId: string, name: EventName, args: Record<string, never>) => Promise<boolean>;
export interface EventSource {
  // Adapter emits each recognized utterance once and supplies reply_to from #16.
  subscribe(callback: (event: SourceEvent) => void): () => void;
}
export interface DispatcherDependencies {
  store: EventStore;
  send: ReadonlySet<EventName>;
  recheckAccess: RecheckAccess;
  post?: WebhookPost;
  source?: EventSource;
  now?: () => number;
  onError?: (reason: "source_failed" | "delivery_failed") => void;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function subscriptionId(principalId: string, identity: SubscriptionIdentity): string {
  return `sub_${createHash("sha256").update(canonicalJson([
    principalId, identity.delivery.url, identity.name, identity.arguments,
  ])).digest("hex")}`;
}

export class EventDispatcher {
  readonly #store: EventStore;
  readonly #post: WebhookPost;
  readonly #now: () => number;
  readonly #dependencies: DispatcherDependencies;
  readonly #verified = new Map<string, number>();
  readonly #locks = new Map<string, Promise<unknown>>();
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #active = new Set<Promise<void>>();
  readonly #disconnect?: () => void;
  #closed = false;

  constructor(dependencies: DispatcherDependencies) {
    this.#dependencies = dependencies;
    this.#store = dependencies.store;
    this.#post = dependencies.post ?? createWebhookPost();
    this.#now = dependencies.now ?? Date.now;
    for (const pending of this.#store.pending()) this.#schedule(pending);
    this.#disconnect = dependencies.source?.subscribe((event) => {
      this.#track(this.publish(event), "source_failed");
    });
  }

  async subscribe(principalId: string, params: SubscribeRequest): Promise<SubscriptionResult> {
    const id = subscriptionId(principalId, params);
    return this.#locked(id, async () => {
      if (this.#closed) throw new ProtocolError(-32603, "Events dispatcher is closed.");
      if (!validSigningSecret(params.delivery.secret)) throw new ProtocolError(-32602, "Invalid signing secret.");
      if (!this.#dependencies.send.has(params.name) || !await this.#dependencies.recheckAccess(principalId, params.name, params.arguments)) {
        throw new ProtocolError(-32001, "Event access denied.");
      }
      const cacheKey = canonicalJson([principalId, params.delivery.url]);
      // Cache endpoint ownership, not the signing key. Rotation signs with both keys.
      if ((this.#verified.get(cacheKey) ?? 0) <= this.#now()) {
        const challenge = randomBytes(32).toString("base64url");
        const body = JSON.stringify({ type: "verification", challenge });
        try {
          const response = await this.#signedPost({ id, url: params.delivery.url, secret: params.delivery.secret },
            `msg_verification_${randomUUID()}`, body);
          if (response.status >= 300 && response.status < 400) throw new CallbackError("redirect");
          if (response.status < 200 || response.status >= 300) throw new CallbackError("challenge_failed");
          const echo: unknown = JSON.parse(response.body);
          if (!echo || typeof echo !== "object" || !("challenge" in echo) || typeof echo.challenge !== "string") {
            throw new CallbackError("challenge_failed");
          }
          const actual = Buffer.from(echo.challenge);
          const expected = Buffer.from(challenge);
          if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new CallbackError("challenge_failed");
        } catch (error) {
          throw new ProtocolError(-32015, "Callback endpoint verification failed.", {
            reason: error instanceof CallbackError ? error.reason : "challenge_failed",
          });
        }
        // Delete old cache entries so refreshed endpoints cannot grow it indefinitely.
        for (const [key, expires] of this.#verified) if (expires <= this.#now()) this.#verified.delete(key);
        this.#verified.set(cacheKey, this.#now() + VERIFICATION_CACHE_MS);
      }
      if (this.#closed || !await this.#dependencies.recheckAccess(principalId, params.name, params.arguments)) {
        throw new ProtocolError(-32001, "Event access denied.");
      }
      const existing = this.#store.get(id);
      const expires = this.#now() + Math.min(params.ttlMs ?? LIFETIME_MS, LIFETIME_MS);
      const rotation = existing && existing.secret !== params.delivery.secret ? {
        previousSecret: existing.secret, rotationUntil: this.#now() + ROTATION_MS,
      } : existing?.rotationUntil && existing.rotationUntil > this.#now() ? {
        previousSecret: existing.previousSecret, rotationUntil: existing.rotationUntil,
      } : {};
      this.#store.put({ id, principalId, name: params.name, arguments: params.arguments,
        url: params.delivery.url, secret: params.delivery.secret, refreshBefore: expires, ...rotation });
      return { id, refreshBefore: new Date(expires).toISOString(), cursor: null, truncated: false };
    });
  }

  async unsubscribe(principalId: string, params: SubscriptionIdentity): Promise<Record<string, never>> {
    const id = subscriptionId(principalId, params);
    return this.#locked(id, async () => {
      this.#remove(id);
      return {};
    });
  }

  async publish(event: SourceEvent): Promise<void> {
    if (this.#closed || !this.#dependencies.send.has(event.name)) return;
    const data = payloadSchemas[event.name].parse(event.data);
    const timestamp = event.timestamp ?? new Date(this.#now()).toISOString();
    z.iso.datetime({ offset: true }).parse(timestamp);
    const eventId = `evt_${randomUUID()}`;
    const body = JSON.stringify({ eventId, name: event.name, timestamp, data, cursor: null });
    if (Buffer.byteLength(body, "utf8") > MAX_EVENT_BYTES) throw new Error("Event payload exceeds 256 KiB.");
    await Promise.all(this.#store.subscriptions().filter((subscription) => subscription.name === event.name)
      .map((subscription) => this.#deliver({ id: `${subscription.id}:${eventId}`, subscriptionId: subscription.id,
        body, attempts: 0, nextAttemptAt: this.#now() })));
  }

  async close(): Promise<void> {
    if (this.#closed) {
      await Promise.allSettled([...this.#active, ...this.#locks.values()]);
      return;
    }
    this.#closed = true;
    this.#disconnect?.();
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    await Promise.allSettled([...this.#active, ...this.#locks.values()]);
  }

  async #signedPost(subscription: Pick<Subscription, "id" | "url" | "secret" | "previousSecret" | "rotationUntil">,
    eventId: string, body: string) {
    const signedAt = new Date(this.#now());
    const signatures = [new Webhook(subscription.secret).sign(eventId, signedAt, body)];
    if (subscription.previousSecret && (subscription.rotationUntil ?? 0) > this.#now()) {
      signatures.push(new Webhook(subscription.previousSecret).sign(eventId, signedAt, body));
    }
    return this.#post(subscription.url, body, {
      "Content-Type": "application/json", "webhook-id": eventId,
      "webhook-timestamp": String(Math.floor(signedAt.getTime() / 1_000)),
      "webhook-signature": signatures.join(" "), "X-MCP-Subscription-Id": subscription.id,
    });
  }

  async #deliver(pending: PendingDelivery): Promise<void> {
    if (this.#closed) return;
    const subscription = this.#store.get(pending.subscriptionId);
    if (!subscription) { this.#store.removePending(pending.id); return; }
    if (!this.#dependencies.send.has(subscription.name) || subscription.refreshBefore <= this.#now()) {
      this.#remove(subscription.id);
      return;
    }
    let status = 0;
    let terminal = false;
    try {
      if (!await this.#dependencies.recheckAccess(subscription.principalId, subscription.name, subscription.arguments)) {
        this.#remove(subscription.id);
        return;
      }
      // Access checks can await external state; recheck unsubscribe/expiration before sending.
      const current = this.#store.get(subscription.id);
      if (this.#closed || !current) return;
      if (current.refreshBefore <= this.#now()) { this.#remove(current.id); return; }
      const event = z.object({ eventId: z.string(), name: z.literal(current.name),
        timestamp: z.iso.datetime({ offset: true }), data: payloadSchemas[current.name], cursor: z.null() }).strict().parse(JSON.parse(pending.body));
      if (Buffer.byteLength(pending.body, "utf8") > MAX_EVENT_BYTES) throw new CallbackError("challenge_failed");
      status = (await this.#signedPost(current, event.eventId, pending.body)).status;
      terminal = (status >= 300 && status < 500 && status !== 408 && status !== 429);
    } catch (error) {
      terminal = error instanceof z.ZodError || error instanceof SyntaxError ||
        (error instanceof CallbackError && error.reason !== "timeout" && error.reason !== "connection_failed" && error.reason !== "dns_failed");
    }
    if (!this.#store.get(subscription.id)) return;
    if (status === 410) { this.#remove(subscription.id); return; }
    if ((status >= 200 && status < 300) || terminal || pending.attempts >= RETRY_DELAYS_MS.length) {
      this.#store.removePending(pending.id);
      return;
    }
    const retry = { ...pending, attempts: pending.attempts + 1,
      nextAttemptAt: this.#now() + RETRY_DELAYS_MS[pending.attempts] };
    this.#store.savePending(retry);
    this.#schedule(retry);
  }

  #schedule(pending: PendingDelivery): void {
    if (this.#closed) return;
    const timer = setTimeout(() => {
      this.#timers.delete(pending.id);
      this.#track(this.#deliver(pending), "delivery_failed");
    }, Math.max(0, pending.nextAttemptAt - this.#now()));
    timer.unref();
    this.#timers.set(pending.id, timer);
  }

  #track(promise: Promise<void>, reason: "source_failed" | "delivery_failed"): void {
    const tracked = promise.catch(() => {
      try { this.#dependencies.onError?.(reason); } catch { /* Diagnostics must not break delivery. */ }
    });
    this.#active.add(tracked);
    void tracked.then(() => this.#active.delete(tracked));
  }

  #remove(id: string): void {
    for (const pending of this.#store.pending()) {
      if (pending.subscriptionId !== id) continue;
      clearTimeout(this.#timers.get(pending.id));
      this.#timers.delete(pending.id);
    }
    this.#store.remove(id);
  }

  async #locked<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(id);
    const next = (previous ?? Promise.resolve()).catch(() => {}).then(operation);
    this.#locks.set(id, next);
    try { return await next; } finally { if (this.#locks.get(id) === next) this.#locks.delete(id); }
  }
}
