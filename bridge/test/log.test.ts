import { describe, expect, it } from "vitest";

import { createLogger } from "../src/log.js";

describe("structured logger", () => {
  it("shows only the wildcard bind address and always redacts PSK", () => {
    const lines: string[] = [];
    const logger = createLogger("info", (line) => lines.push(line));
    logger.info("bridge_started", { host: "0.0.0.0", port: 8790, psk: "test-only-key" });
    expect(JSON.parse(lines[0] ?? "")).toEqual({
      level: "info", event: "bridge_started", host: "0.0.0.0", port: 8790, psk: "<redacted>",
    });
    expect(lines.join("\n")).not.toContain("test-only-key");
  });

  it("redacts sensitive fields and IP-shaped strings", () => {
    const lines: string[] = [];
    const logger = createLogger("debug", (line) => lines.push(line));
    logger.warn("auth_rejected", {
      host: "private-host",
      remote_ip: "192.0.2.10",
      message: "connection from 198.51.100.8",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("private-host");
    expect(lines[0]).not.toContain("192.0.2.10");
    expect(lines[0]).not.toContain("198.51.100.8");
  });
});
