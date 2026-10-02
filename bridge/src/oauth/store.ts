import {
  closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, unlinkSync, writeFileSync, fstatSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { randomSecret } from "./crypto.js";

const MAX_STORE_BYTES = 32 * 1024 * 1024;

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const expires = z.number().int().nonnegative();
const client = z.object({
  hash: digest, redirectUris: z.array(z.string()).min(1).max(10),
  name: z.string(), refresh: z.boolean(),
}).strict();
const grant = z.object({
  clientHash: digest, redirectUri: z.string(), challenge: z.string(),
  state: z.string().nullable(), resource: z.string(),
}).strict();
const pending = grant.extend({ hash: digest, cookieHash: digest, expires });
const code = grant.extend({ hash: digest, expires, family: digest.nullable() });
const token = z.object({
  hash: digest, clientHash: digest, resource: z.string(), family: digest,
  expires, used: z.boolean(),
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

/** Synchronous transactions serialize mutations, including across processes. No secret values on disk. */
export class OAuthStore {
  readonly #file: string;
  readonly #lock: string;
  constructor(readonly directory: string, readonly resource?: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())) {
      throw new Error("OAuth store directory must be private (0700) and owned by this user.");
    }
    this.#file = join(directory, "store.json");
    this.#lock = join(directory, "transaction.lock");
  }

  transaction<T>(mutate: (data: StoreData) => T): T {
    // Fail closed on contention or a crash-left lock; never guess that another writer is dead.
    const lock = openSync(this.#lock, "wx", 0o600);
    try {
      const data = this.#read();
      const result = mutate(data);
      const validated = schema.parse(data);
      this.#write(validated);
      return result;
    } finally {
      closeSync(lock);
      unlinkSync(this.#lock);
    }
  }

  read(): StoreData { return this.#read(); }

  #read(): StoreData {
    if (!existsSync(this.#file)) {
      if (!this.resource) throw new Error("OAuth store does not exist.");
      return empty(this.resource);
    }
    const file = openSync(this.#file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(file);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > MAX_STORE_BYTES ||
          (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe OAuth store file.");
      const data = schema.parse(JSON.parse(readFileSync(file, "utf8")));
      if (this.resource && data.resource !== this.resource) {
        const revoked = [data.clients, data.pending, data.codes, data.access, data.refresh].every((entries) => entries.length === 0);
        if (!revoked) throw new Error("OAuth resource changed; revoke the store first.");
        data.resource = this.resource;
      }
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
      const dir = openSync(this.directory, constants.O_RDONLY);
      try { fsyncSync(dir); } finally { closeSync(dir); }
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
}

export function prune(data: StoreData, now: number): void {
  data.pending = data.pending.filter((entry) => entry.expires > now);
  data.codes = data.codes.filter((entry) => entry.expires > now);
  data.access = data.access.filter((entry) => entry.expires > now);
  data.refresh = data.refresh.filter((entry) => entry.expires > now);
}

export function revokeFamily(data: StoreData, family: string): void {
  data.access = data.access.filter((entry) => entry.family !== family);
  data.refresh = data.refresh.filter((entry) => entry.family !== family);
}
