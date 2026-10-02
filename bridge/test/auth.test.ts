import { describe, expect, it } from "vitest";

import { createDeviceAuth, ReplayCache, verifyDeviceAuth } from "../src/auth.js";

const psk = "test-only-key";
const deviceId = "test-device";
const now = 2_000_000_000;

function headers(timestamp = String(now), key = psk) {
  return {
    "x-device-id": deviceId,
    "x-timestamp": timestamp,
    "x-auth": createDeviceAuth(key, deviceId, timestamp),
  };
}

describe("verifyDeviceAuth", () => {
  it("accepts a valid HMAC", () => {
    expect(verifyDeviceAuth(headers(), psk, now, new ReplayCache())).toEqual({ ok: true, deviceId });
  });

  it("rejects an HMAC made with another PSK", () => {
    expect(verifyDeviceAuth(headers(String(now), "wrong-key"), psk, now, new ReplayCache())).toMatchObject({
      ok: false,
      reason: "invalid_auth",
    });
  });

  it("rejects timestamps outside the 60 second window", () => {
    expect(verifyDeviceAuth(headers(String(now - 61)), psk, now, new ReplayCache())).toMatchObject({
      ok: false,
      reason: "timestamp_out_of_range",
    });
  });

  it("rejects reuse of an accepted credential tuple", () => {
    const cache = new ReplayCache();
    expect(verifyDeviceAuth(headers(), psk, now, cache).ok).toBe(true);
    expect(verifyDeviceAuth(headers(), psk, now, cache)).toMatchObject({ ok: false, reason: "replay" });
  });

  it("uses replay protection when no cache is supplied", () => {
    const timestamp = String(now + 1);
    expect(verifyDeviceAuth(headers(timestamp), psk, now).ok).toBe(true);
    expect(verifyDeviceAuth(headers(timestamp), psk, now)).toMatchObject({ ok: false, reason: "replay" });
  });
});
