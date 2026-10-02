import {
  closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, unlinkSync, writeFileSync, fstatSync, realpathSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { equalHash, randomSecret } from "./crypto.js";
import { acquireStoreLock, releaseStoreLock } from "./store-lock.js";

const MAX_STORE_BYTES = 32 * 1024 * 1024;

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const expires = z.number().int().nonnegative();
const client = z.object({
  hash: digest, redirectUris: z.array(z.string()).min(1).max(10),
  name: z.string(), refresh: z.boolean(),
  createdAt: expires.default(0), used: z.boolean().default(false),
}).strict();
const grant = z.object({
  clientHash: digest, redirectUri: z.string(), challenge: z.string(),
  state: z.string().nullable(), resource: z.string(),
}).strict();
const pending = grant.extend({ hash: digest, cookieHash: digest, expires });
const code = grant.extend({ hash: digest, expires, family: digest.nullable() });
const token = z.object({
  hash: digest, clientHash: digest, resource: z.string(), family: digest,
  expires, used: z.boolean(), rotatedAt: expires.optional(), replacement: digest.optional(), rotationSalt: digest.optional(),
}).strict();
const counter = z.object({ failures: z.number().int().nonnegative(), until: expires }).strict();
const schema = z.object({
  version: z.literal(1), resource: z.string(),
  clients: z.array(client).max(100), pending: z.array(pending).max(256),
  codes: z.array(code).max(256), access: z.array(token).max(4096),
  refresh: z.array(token).max(4096),
  lockouts: z.record(z.string(), counter),
}).strict();
export type StoreData = z.infer<typeof schema>;
export type Grant = z.infer<typeof grant>;
export type StoredClient = z.infer<typeof client>;

function empty(resource: string): StoreData {
  return { version: 1, resource, clients: [], pending: [], codes: [], access: [], refresh: [], lockouts: {} };
}

// Shared by all store instances for a directory; asynchronous waiters never block the event loop.
const mutexes = new Map<string, Promise<void>>();
/** Atomic private-file transactions with an in-process mutex and crash recovery. */
export class OAuthStore {
  readonly #file: string;
  readonly #lock: string;
  readonly #key: string;
  #cache?: { key: string; data: StoreData };
  constructor(readonly directory: string, readonly resource?: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())) {
      throw new Error("OAuth store directory must be private (0700) and owned by this user.");
    }
    this.#key = realpathSync(directory);
    this.#file = join(directory, "store.json");
    this.#lock = join(directory, "transaction.lock");
  }

  async transaction<T>(mutate: (data: StoreData) => T | Promise<T>): Promise<T> {
    const previous = mutexes.get(this.#key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    mutexes.set(this.#key, current);
    await previous;
    let lock: number | undefined;
    try {
      lock = await acquireStoreLock(this.#lock, this.directory);
      const data = this.read();
      const result = await mutate(data);
      this.#write(schema.parse(data));
      return result;
    } finally {
      try {
        if (lock !== undefined) releaseStoreLock(this.#lock, lock);
      } finally {
        release();
        if (mutexes.get(this.#key) === current) mutexes.delete(this.#key);
      }
    }
  }

  validAccess(tokenHash: string, resource: string, now: number): boolean {
    return this.#read().access.some((token) => equalHash(token.hash, tokenHash) && token.resource === resource && token.expires > now);
  }

  accessPrincipal(tokenHash: string, resource: string, now: number): string | null {
    const token = this.#read().access.find(token => equalHash(token.hash, tokenHash) && token.resource === resource && token.expires > now);
    return token ? `oauth:${token.family}` : null;
  }

  principalActive(principal: string, resource: string, now: number): boolean {
    if (!principal.startsWith("oauth:")) return false;
    const family = principal.slice(6);
    const data = this.#read();
    return [...data.access, ...data.refresh].some(token => token.family === family && token.resource === resource &&
      token.expires > now && !token.used);
  }

  // Callers receive a copy, so neither a failed transaction nor an accidental edit poisons the cache.
  read(): StoreData { return structuredClone(this.#read()); }

  #read(): StoreData {
    if (!existsSync(this.#file)) {
      if (!this.resource) throw new Error("OAuth store does not exist.");
      return empty(this.resource);
    }
    const file = openSync(this.#file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(file, { bigint: true });
      if (!stat.isFile() || (stat.mode & 0o077n) !== 0n || stat.size > BigInt(MAX_STORE_BYTES) ||
          (process.getuid && stat.uid !== BigInt(process.getuid()))) throw new Error("Unsafe OAuth store file.");
      const key = `${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}:${stat.dev}:${stat.ino}`;
      const data = this.#cache?.key === key ? this.#cache.data : schema.parse(JSON.parse(readFileSync(file, "utf8")));
      if (this.resource && data.resource !== this.resource) {
        const revoked = [data.clients, data.pending, data.codes, data.access, data.refresh].every((entries) => entries.length === 0);
        if (!revoked) throw new Error("OAuth resource changed; revoke the store first.");
        data.resource = this.resource;
      }
      // Upgrade older registrations from the available token/redemption evidence. Unknown unused
      // registrations have no timestamp, so they expire on the next pruning transaction.
      if (this.#cache?.key !== key) {
        const usedClients = new Set([...data.access, ...data.refresh, ...data.codes.filter((code) => code.family !== null)]
          .map((entry) => entry.clientHash));
        for (const client of data.clients) if (usedClients.has(client.hash)) client.used = true;
      }
      this.#cache = { key, data };
      return data;
    } finally { closeSync(file); }
  }

  #write(data: StoreData): void {
    const serialized = JSON.stringify(data);
    if (Buffer.byteLength(serialized) > MAX_STORE_BYTES) throw new Error("OAuth store capacity reached.");
    const temporary = join(this.directory, `${randomSecret()}.tmp`);
    const file = openSync(temporary, "wx", 0o600);
    try {
      try {
        writeFileSync(file, serialized);
        fsyncSync(file);
      } finally { closeSync(file); }
      renameSync(temporary, this.#file);
      this.#cache = undefined;
      const dir = openSync(this.directory, constants.O_RDONLY);
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
}

export function prune(data: StoreData, now: number): void {
  data.clients = data.clients.filter((entry) => entry.used || entry.createdAt + 60 * 60 * 1000 > now);
  const clients = new Set(data.clients.map((entry) => entry.hash));
  data.pending = data.pending.filter((entry) => entry.expires > now && clients.has(entry.clientHash));
  data.codes = data.codes.filter((entry) => entry.expires > now && clients.has(entry.clientHash));
  data.access = data.access.filter((entry) => entry.expires > now && clients.has(entry.clientHash));
  data.refresh = data.refresh.filter((entry) => entry.expires > now && clients.has(entry.clientHash));
}

export function revokeFamily(data: StoreData, family: string): void {
  data.access = data.access.filter((entry) => entry.family !== family);
  data.refresh = data.refresh.filter((entry) => entry.family !== family);
}
