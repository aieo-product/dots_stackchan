import { describe, expect, it } from "vitest";
import { loadSlackConfig } from "../src/slack/config.js";

const environment = {
  SLACK_ENABLED: "true",
  SLACK_APP_TOKEN: ["xapp", "test-only"].join("-"),
  SLACK_USER_TOKEN: ["xoxp", "test-only"].join("-"),
  SLACK_DOT_USER_ID: "UDOTTEST",
};

describe("Slack configuration", () => {
  it("is opt-in and does not require credentials when disabled", () => {
    expect(loadSlackConfig({})).toEqual({ enabled: false });
    expect(loadSlackConfig({ SLACK_ENABLED: "false", SLACK_USER_TOKEN: "invalid" }))
      .toEqual({ enabled: false });
  });
  it("loads defaults and an existing DM override", () => {
    expect(loadSlackConfig(environment)).toMatchObject({ enabled: true, readSentences: 2 });
    expect(loadSlackConfig({ ...environment, SLACK_CHANNEL: "DTESTDM", SLACK_READ_SENTENCES: "3" }))
      .toMatchObject({ channel: "DTESTDM", readSentences: 3 });
  });
  it("accepts a bot ID for sender matching", () => {
    expect(loadSlackConfig({ ...environment, SLACK_DOT_USER_ID: "BDOTTEST" }))
      .toMatchObject({ dotUserId: "BDOTTEST" });
  });
  it.each(["0", "-1", "1.5", "21", "NaN"])("rejects sentence count %s", (value) => {
    expect(() => loadSlackConfig({ ...environment, SLACK_READ_SENTENCES: value }))
      .toThrow("SLACK_READ_SENTENCES");
  });
  it("rejects bot tokens, non-DM channels, and invalid flags without leaking values", () => {
    const invalidToken = ["xoxb", "private-test-value"].join("-");
    expect(() => loadSlackConfig({ ...environment, SLACK_USER_TOKEN: invalidToken }))
      .toThrow(/^Invalid Slack configuration: SLACK_USER_TOKEN$/);
    expect(() => loadSlackConfig({ ...environment, SLACK_CHANNEL: "CTEST" })).toThrow("SLACK_CHANNEL");
    expect(() => loadSlackConfig({ SLACK_ENABLED: "yes" })).toThrow("SLACK_ENABLED");
    expect(() => loadSlackConfig({ SLACK_ENABLED: "true" }))
      .toThrow("SLACK_APP_TOKEN, SLACK_USER_TOKEN, SLACK_DOT_USER_ID");
  });
});
