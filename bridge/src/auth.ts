import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export const AUTH_TOLERANCE_SECONDS = 60;

export type AuthFailureReason = "missing_headers" | "invalid_timestamp" | "timestamp_out_of_range" | "invalid_auth" | "replay";

export type AuthResult =
  | { ok: true; deviceId: string }
  | { ok: false; reason: AuthFailureReason; deviceId?: string };

export class ReplayCache {
  private readonly entries = new Map<string, number>();

  public constructor(private readonly maximumEntries = 1_024) {}

  public use(key: string, expiresAtSeconds: number, nowSeconds: number): boolean {
    this.prune(nowSeconds);
    if (this.entries.has(key)) return false;
    this.entries.set(key, expiresAtSeconds);
    while (this.entries.size > this.maximumEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return true;
  }

  private prune(nowSeconds: number): void {
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt < nowSeconds) this.entries.delete(key);
    }
  }
}

const sharedReplayCache = new ReplayCache();

function singleHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? undefined : value;
}

export function createDeviceAuth(psk: string, deviceId: string, timestamp: string): string {
  return createHmac("sha256", psk).update(`${deviceId}:${timestamp}`).digest("hex");
}

export function verifyDeviceAuth(
  headers: IncomingHttpHeaders,
  psk: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
  replayCache = sharedReplayCache,
): AuthResult {
  const deviceId = singleHeader(headers, "x-device-id");
  const timestamp = singleHeader(headers, "x-timestamp");
  const auth = singleHeader(headers, "x-auth");
  if (!deviceId || !timestamp || !auth || !psk) return { ok: false, reason: "missing_headers", deviceId };

  if (!/^\d+$/.test(timestamp)) return { ok: false, reason: "invalid_timestamp", deviceId };
  const parsedTimestamp = Number(timestamp);
  if (!Number.isSafeInteger(parsedTimestamp)) return { ok: false, reason: "invalid_timestamp", deviceId };
  if (Math.abs(nowSeconds - parsedTimestamp) > AUTH_TOLERANCE_SECONDS) {
    return { ok: false, reason: "timestamp_out_of_range", deviceId };
  }

  const expected = Buffer.from(createDeviceAuth(psk, deviceId, timestamp), "hex");
  if (!/^[\da-f]{64}$/i.test(auth)) return { ok: false, reason: "invalid_auth", deviceId };
  const actual = Buffer.from(auth, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: "invalid_auth", deviceId };
  }

  const replayKey = `${deviceId}\0${timestamp}\0${auth.toLowerCase()}`;
  const expiresAt = parsedTimestamp + AUTH_TOLERANCE_SECONDS;
  if (!replayCache.use(replayKey, expiresAt, nowSeconds)) return { ok: false, reason: "replay", deviceId };
  return { ok: true, deviceId };
}
