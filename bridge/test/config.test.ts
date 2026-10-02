import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("loads required secrets and defaults to a LAN-accessible bind address", () => {
    expect(loadConfig({ DEVICE_PSK: "test-only-key" })).toEqual({
      devicePsk: "test-only-key",
      port: 8790,
      host: "0.0.0.0",
      logLevel: "info",
    });
  });

  it("defaults an empty bind host and honors an explicit override", () => {
    expect(loadConfig({ DEVICE_PSK: "test-only-key", BRIDGE_HOST: "" }).host).toBe("0.0.0.0");
    expect(loadConfig({ DEVICE_PSK: "test-only-key", BRIDGE_HOST: "localhost" }).host).toBe("localhost");
  });

  it("names invalid or missing keys without exposing values", () => {
    expect(() => loadConfig({ BRIDGE_PORT: "invalid" })).toThrow("DEVICE_PSK, BRIDGE_PORT");
  });
});
