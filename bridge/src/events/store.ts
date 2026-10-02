import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { eventNameSchema } from "./catalog.js";
import { seal, unseal, validSigningSecret } from "./crypto.js";

const subscriptionSchema = z.object({
  id: z.string(), principalId: z.string(), name: eventNameSchema,
  arguments: z.object({}).strict(), url: z.string(),
  secret: z.string(), refreshBefore: z.number(),
  previousSecret: z.string().optional(), rotationUntil: z.number().optional(),
});
const pendingSchema = z.object({
  id: z.string(), subscriptionId: z.string(), body: z.string(),
  attempts: z.number().int().min(1).max(5), nextAttemptAt: z.number(),
});
export type Subscription = z.infer<typeof subscriptionSchema>;
export type PendingDelivery = z.infer<typeof pendingSchema>;
const stateSchema = z.object({
  version: z.literal(1), subscriptions: z.array(subscriptionSchema), pending: z.array(pendingSchema),
});

export class EventStore {
  #subscriptions = new Map<string, Subscription>();
  #pending = new Map<string, PendingDelivery>();
  readonly #file: string;
  readonly #key: Buffer;

  constructor(directory: string, key: Buffer) {
    if (key.length !== 32) throw new Error("Events storage requires a 32-byte key.");
    this.#key = Buffer.from(key);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.#file = join(directory, "events.json");
    let contents: string;
    try { contents = readFileSync(this.#file, "utf8"); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error("Events storage could not be read.");
    }
    try {
      const state = stateSchema.parse(JSON.parse(contents));
      for (const stored of state.subscriptions) {
        const subscription = { ...stored, secret: unseal(stored.secret, key, stored.id),
          ...(stored.previousSecret ? { previousSecret: unseal(stored.previousSecret, key, stored.id) } : {}) };
        if (!validSigningSecret(subscription.secret) ||
          (subscription.previousSecret && !validSigningSecret(subscription.previousSecret))) throw new Error();
        this.#subscriptions.set(stored.id, subscription);
      }
      for (const pending of state.pending) {
        this.#pending.set(pending.id, { ...pending, body: unseal(pending.body, key, pending.id) });
      }
      chmodSync(this.#file, 0o600);
    } catch { throw new Error("Events storage is invalid or cannot be decrypted."); }
  }

  subscriptions(): Subscription[] { return structuredClone([...this.#subscriptions.values()]); }
  get(id: string): Subscription | undefined {
    const value = this.#subscriptions.get(id);
    return value && structuredClone(value);
  }
  pending(): PendingDelivery[] { return structuredClone([...this.#pending.values()]); }
  put(subscription: Subscription): void {
    this.#mutate(() => this.#subscriptions.set(subscription.id, structuredClone(subscription)));
  }
  remove(id: string): void {
    this.#mutate(() => {
      this.#subscriptions.delete(id);
      for (const [key, pending] of this.#pending) if (pending.subscriptionId === id) this.#pending.delete(key);
    });
  }
  savePending(pending: PendingDelivery): void {
    this.#mutate(() => this.#pending.set(pending.id, structuredClone(pending)));
  }
  removePending(id: string): void { this.#mutate(() => this.#pending.delete(id)); }

  #mutate(change: () => void): void {
    const subscriptions = new Map(this.#subscriptions);
    const pending = new Map(this.#pending);
    try { change(); this.#save(); } catch {
      this.#subscriptions = subscriptions;
      this.#pending = pending;
      throw new Error("Events storage could not be saved.");
    }
  }

  #save(): void {
    const state = {
      version: 1,
      subscriptions: this.subscriptions().map((subscription) => ({ ...subscription,
        secret: seal(subscription.secret, this.#key, subscription.id),
        ...(subscription.previousSecret ? { previousSecret: seal(subscription.previousSecret, this.#key, subscription.id) } : {}),
      })),
      pending: this.pending().map((pending) => ({ ...pending, body: seal(pending.body, this.#key, pending.id) })),
    };
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.#file);
    } finally { rmSync(temporary, { force: true }); }
  }
}
