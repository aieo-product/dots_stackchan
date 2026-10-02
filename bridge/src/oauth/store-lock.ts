import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync,
  readFileSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";

import { randomSecret } from "./crypto.js";

const PROCESS_START = Math.floor(Date.now() - process.uptime() * 1000);
const ownerSchema = z.object({
  pid: z.number().int().positive(), startTime: z.number().int().nonnegative(), id: z.string().optional(), cancelled: z.boolean().optional(),
}).strict();

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error; // Permission errors do not establish that a writer is dead.
  }
}

function owners(fd: number): z.infer<typeof ownerSchema>[] {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.size > 32 * 1024 || (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())) throw new Error("Unsafe OAuth lock.");
  const log = readFileSync(fd, "utf8").split("\n").map((line) => ownerSchema.parse(JSON.parse(line)));
  const cancelled = new Set(log.filter((owner) => owner.cancelled).map((owner) => owner.id));
  return log.filter((owner) => !owner.cancelled && (owner.id === undefined || !cancelled.has(owner.id)));
}

/** Return an owned lock descriptor; only its owner may remove the lock after committing. */
export async function acquireStoreLock(path: string, directory: string): Promise<number> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const identity = { pid: process.pid, startTime: PROCESS_START, id: randomSecret() };
    const serialized = JSON.stringify(identity);
    // Publish completed metadata atomically so a crash cannot leave an empty lock file.
    const temporary = join(directory, `${randomSecret()}.tmp`);
    const candidate = openSync(temporary, "wx", 0o600);
    let acquired = false;
    try {
      writeFileSync(candidate, serialized);
      fsyncSync(candidate);
      linkSync(temporary, path);
      acquired = true;
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      if (!acquired) closeSync(candidate);
      unlinkSync(temporary);
    }

    let fd: number;
    try { fd = openSync(path, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    let claimed = false;
    try {
      if (!owners(fd).some((owner) => alive(owner.pid))) {
        // Claim the existing inode with a single O_APPEND write, rather than unlinking a stale
        // path. Competing reapers agree on the first live claimant in the append log; neither
        // can remove a newly acquired replacement lock between a stat and an unlink.
        writeFileSync(fd, `\n${serialized}`);
        claimed = true;
        fsyncSync(fd);
        const check = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const held = fstatSync(fd);
          const current = fstatSync(check);
          const firstLive = owners(check).find((owner) => alive(owner.pid));
          if (held.ino === current.ino && held.dev === current.dev && firstLive?.id === identity.id) {
            acquired = true;
            return fd;
          }
        } finally { closeSync(check); }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      if (!acquired) {
        try {
          // A live loser must not prevent future recovery if the winning writer then crashes.
          if (claimed) writeFileSync(fd, `\n${JSON.stringify({ ...identity, cancelled: true })}`);
        } finally { closeSync(fd); }
      }
    }
    if (Date.now() >= deadline) throw new Error("OAuth store is busy.");
    await delay(20);
  }
}

export function releaseStoreLock(path: string, fd: number): void {
  try {
    const held = fstatSync(fd);
    const current = lstatSync(path);
    if (held.ino !== current.ino || held.dev !== current.dev) throw new Error("OAuth lock ownership changed.");
    unlinkSync(path);
  } finally { closeSync(fd); }
}
