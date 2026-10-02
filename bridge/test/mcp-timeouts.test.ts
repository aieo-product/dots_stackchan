import { createServer } from "node:http";
import { expect, it, vi } from "vitest";

import { createMcpServer } from "../src/mcp/server.js";
import { harness } from "./oauth-helpers.js";

vi.mock("node:http", async (importOriginal) => {
  const http = await importOriginal<typeof import("node:http")>();
  return { ...http, createServer: vi.fn(http.createServer) };
});

it("L6: configures request/header deadlines and idle keep-alive on the public listener", async () => {
  const h = harness();
  const server = createMcpServer({
    device: { online: false, caps: { sanotts: true, servo: true, mic: true }, send() {}, sendBinary() {}, on() {} },
    speaker: { say: () => ({ id: "timeout-test", estimatedSeconds: 1, done: Promise.resolve() }), cancelAll() {} },
    listener: { nextUtterance: () => Promise.resolve(null) },
  }, { oauth: h.oauth });
  try {
    await server.listen(0);
    expect(createServer).toHaveBeenCalledWith({ requestTimeout: 30_000, headersTimeout: 30_000, keepAliveTimeout: 5_000 }, expect.any(Function));
    const actual = vi.mocked(createServer).mock.results.at(-1)?.value as ReturnType<typeof createServer>;
    expect(actual.requestTimeout).toBe(30_000);
    expect(actual.headersTimeout).toBe(30_000);
    expect(actual.keepAliveTimeout).toBe(5_000);
  } finally { await server.close(); h.cleanup(); }
});
