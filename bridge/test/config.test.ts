import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("loads required secrets and defaults to a LAN-accessible bind address", () => {
    expect(loadConfig({ DEVICE_PSK: "test-only-key" })).toEqual({
      devicePsk: "test-only-key",
      port: 8790,
      host: "0.0.0.0",
      logLevel: "info",
      sttEngine: "openai-realtime",
      sttModel: "gpt-live-transcribe",
      sttBatchModel: "gpt-transcribe",
      sttLanguage: "ja",
      logTranscripts: false,
      openaiApiKey: undefined,
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

describe("STT configuration", () => {
  it("honors model/language overrides and selects the batch default", () => {
    expect(loadConfig({ DEVICE_PSK: "test-only-key", STT_ENGINE: "openai-batch" }).sttModel).toBe("gpt-transcribe");
    expect(loadConfig({ DEVICE_PSK: "test-only-key", STT_ENGINE: "fake", STT_MODEL: "custom-model", STT_BATCH_MODEL: "batch-model", STT_LANGUAGE: "en", LOG_TRANSCRIPTS: "true" }))
      .toMatchObject({ sttEngine: "fake", sttModel: "custom-model", sttBatchModel: "batch-model", sttLanguage: "en", logTranscripts: true });
  });
  it("rejects unsupported engines and invalid flags without exposing values", () => {
    expect(() => loadConfig({ DEVICE_PSK: "test-only-key", STT_ENGINE: "local", LOG_TRANSCRIPTS: "yes" })).toThrow("STT_ENGINE, LOG_TRANSCRIPTS");
    expect(() => loadConfig({ DEVICE_PSK: "test-only-key", STT_LANGUAGE: "invalid language" })).toThrow("STT_LANGUAGE");
  });
});
