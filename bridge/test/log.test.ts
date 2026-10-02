import { describe, expect, it } from "vitest";

import { createLogger } from "../src/log.js";

describe("structured logger", () => {
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
