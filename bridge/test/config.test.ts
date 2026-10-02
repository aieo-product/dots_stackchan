import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("loads required secrets and applies safe defaults", () => {
    expect(loadConfig({ DEVICE_PSK: "test-only-key" })).toEqual({
      devicePsk: "test-only-key",
      port: 8790,
      host: "localhost",
      logLevel: "info",
    });
  });

  it("names invalid or missing keys without exposing values", () => {
    expect(() => loadConfig({ BRIDGE_PORT: "invalid" })).toThrow("DEVICE_PSK, BRIDGE_PORT");
  });
});
