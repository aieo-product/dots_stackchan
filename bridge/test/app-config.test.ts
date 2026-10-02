import { expect, it } from "vitest";
import { loadAppConfig } from "../src/app/config.js";

const base = { DEVICE_PSK: "test-only", STT_ENGINE: "fake", EVENTS_ENABLED: "false" };
it("loads all defaults without optional credentials", () => {
  const config = loadAppConfig(base);
  expect(config.mcp).toEqual({ MCP_HOST: "127.0.0.1", MCP_PORT: 8791 });
  expect(config.tts.VOICE_MODE).toBe("device");
  expect(config.slack).toEqual({ enabled: false });
  expect(config.events.enabled).toBe(false);
  expect(config.oauth).toBeUndefined();
});
it("reports failures from every schema without echoing environment values", () => {
  const privateValue = "synthetic-private-value";
  let message = "";
  try {
    loadAppConfig({ DEVICE_PSK: "", BRIDGE_PORT: "wrong", STT_ENGINE: privateValue, VOICE_MODE: privateValue,
      MCP_HOST: privateValue, QUIET_HOURS: privateValue, EVENTS_ENABLED: "true", EVENTS_SECRET_KEY: privateValue,
      SLACK_ENABLED: "true", SLACK_APP_TOKEN: privateValue, ROUTE: privateValue,
      MCP_PUBLIC_URL: privateValue, MCP_PASSCODE: privateValue });
  } catch (error) { message = String(error); }
  for (const name of ["STT_", "VOICE_MODE", "MCP_HOST", "QUIET_HOURS", "EVENTS_SECRET_KEY", "SLACK_", "ROUTE", "MCP_PUBLIC_URL"]) {
    expect(message).toContain(name);
  }
  expect(message).not.toContain(privateValue);
});
it("requires injected credentials and the Slack opt-in for its route", () => {
  expect(() => loadAppConfig({ ...base, DEVICE_PSK: "keychain://DEVICE_PSK" })).toThrow("DEVICE_PSK must be injected");
  expect(() => loadAppConfig({ ...base, STT_ENGINE: "openai-batch" })).toThrow("OPENAI_API_KEY");
  expect(() => loadAppConfig({ ...base, VOICE_MODE: "bridge" })).toThrow("OPENAI_API_KEY");
  expect(() => loadAppConfig({ ...base, EVENTS_ENABLED: "true" })).toThrow("EVENTS_SECRET_KEY");
  expect(() => loadAppConfig({ ...base, ROUTE: "slack" })).toThrow("SLACK_ENABLED");
});
