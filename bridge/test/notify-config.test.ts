import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { notificationConfigSchema } from "../src/notify/config.js";
import { isQuietHours, parseQuietHours, quietHoursEnd } from "../src/notify/quiet-hours.js";

function hours(value: string) {
  const result = parseQuietHours(value);
  if (result === undefined) throw new Error("Expected a quiet-hour window.");
  return result;
}

const local = (hour: number, minute = 0, day = 15) => new Date(2026, 0, day, hour, minute).getTime();

describe("notification settings", () => {
  it("defaults to overnight quiet, ten-minute dedup and redacted logging", () => {
    expect(notificationConfigSchema.parse({})).toEqual({
      QUIET_HOURS: { startMinute: 22 * 60, endMinute: 7 * 60 },
      QUIET_ALLOW_HIGH: false,
      NOTIFY_DEDUP_WINDOW_S: 600,
      LOG_NOTIFICATIONS: false,
    });
  });

  it("parses environment strings and permits explicitly disabling quiet hours", () => {
    expect(notificationConfigSchema.parse({
      QUIET_HOURS: "", QUIET_ALLOW_HIGH: "true", NOTIFY_DEDUP_WINDOW_S: "30", LOG_NOTIFICATIONS: "true",
    })).toEqual({
      QUIET_HOURS: undefined, QUIET_ALLOW_HIGH: true, NOTIFY_DEDUP_WINDOW_S: 30, LOG_NOTIFICATIONS: true,
    });
  });

  it.each([
    { QUIET_HOURS: "24:00-07:00" }, { QUIET_HOURS: "22:60-07:00" },
    { QUIET_HOURS: "7:00-22:00" }, { QUIET_HOURS: "07:00-07:00" },
    { QUIET_ALLOW_HIGH: "yes" }, { LOG_NOTIFICATIONS: "1" },
    { NOTIFY_DEDUP_WINDOW_S: "-1" }, { NOTIFY_DEDUP_WINDOW_S: "Infinity" },
  ])("rejects invalid settings: %j", (settings) => {
    expect(() => notificationConfigSchema.parse(settings)).toThrow();
  });
});

describe("local quiet-hour boundaries", () => {
  it("includes the start and excludes the end of an overnight window", () => {
    const window = hours("22:00-07:00");
    expect(isQuietHours(window, local(21, 59))).toBe(false);
    expect(isQuietHours(window, local(22))).toBe(true);
    expect(isQuietHours(window, local(0, 0, 16))).toBe(true);
    expect(isQuietHours(window, local(6, 59, 16))).toBe(true);
    expect(isQuietHours(window, local(7, 0, 16))).toBe(false);
    expect(quietHoursEnd(window, local(23))).toBe(local(7, 0, 16));
    expect(quietHoursEnd(window, local(6, 30, 16))).toBe(local(7, 0, 16));
  });

  it("handles same-day windows and disabled quiet hours", () => {
    const window = hours("12:30-14:00");
    expect(isQuietHours(window, local(12, 29))).toBe(false);
    expect(isQuietHours(window, local(12, 30))).toBe(true);
    expect(isQuietHours(window, local(14))).toBe(false);
    expect(quietHoursEnd(window, local(13))).toBe(local(14));
    expect(isQuietHours(parseQuietHours(""), local(23))).toBe(false);
  });

  it("rolls across month and year boundaries using the OS calendar", () => {
    const window = hours("22:00-07:00");
    expect(quietHoursEnd(window, new Date(2026, 11, 31, 23).getTime()))
      .toBe(new Date(2027, 0, 1, 7).getTime());
  });
});

// A child process makes the OS timezone deterministic without changing other tests.
describe("quiet hours across daylight saving transitions", () => {
  it.each([
    ["22:00-02:30", "2026-03-08T01:59:00-05:00", "2026-03-08T03:00:00-04:00"],
    ["22:00-01:30", "2026-11-01T01:15:00-05:00", "2026-11-01T01:30:00-05:00"],
  ])("finds the actual quiet end for %s at %s", (setting, start, expected) => {
    const source = readFileSync(new URL("../src/notify/quiet-hours.ts", import.meta.url), "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const script = `${compiled}\nconsole.log(quietHoursEnd(parseQuietHours(${JSON.stringify(setting)}), Date.parse(${JSON.stringify(start)})));`;
    const output = execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
      env: { TZ: "America/New_York" }, encoding: "utf8",
    });
    expect(Number(output.trim())).toBe(Date.parse(expected));
  });
});
