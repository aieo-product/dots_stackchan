import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../src/log.js";
import { loadUtteranceRoute, UtteranceRouter, type UtteranceRoute } from "../src/slack/router.js";

describe("utterance routing", () => {
  it("defaults to MCP and validates ROUTE without including its value", () => {
    expect(loadUtteranceRoute({})).toBe("mcp");
    for (const route of ["mcp", "slack", "both"]) expect(loadUtteranceRoute({ ROUTE: route })).toBe(route);
    expect(() => loadUtteranceRoute({ ROUTE: "private-invalid-value" })).toThrow(/^Invalid ROUTE$/);
  });
  it.each<UtteranceRoute>(["mcp", "slack", "both"])("sends ROUTE=%s to selected handlers only", (route) => {
    const source = new EventEmitter();
    const mcp = vi.fn(); const slack = vi.fn();
    const router = new UtteranceRouter(source, route, mcp);
    router.on("utterance", slack);
    const u = { text: "hello", lang: "ja", reply_to: "reply-id" };
    source.emit("utterance", u);
    expect(mcp).toHaveBeenCalledTimes(route === "slack" ? 0 : 1);
    expect(slack).toHaveBeenCalledTimes(route === "mcp" ? 0 : 1);
    if (route !== "mcp") expect(slack).toHaveBeenCalledWith(u);
    router.dispose(); source.emit("utterance", u);
    expect(slack).toHaveBeenCalledTimes(route === "mcp" ? 0 : 1);
  });
  it("requires MCP wiring when selected", () => {
    expect(() => new UtteranceRouter(new EventEmitter(), "both")).toThrow("MCP utterance handler");
  });
  it("isolates synchronous and asynchronous route failures", async () => {
    const source = new EventEmitter(); const slack = vi.fn(); const lines: string[] = [];
    const mcp = vi.fn().mockImplementationOnce(() => { throw new Error("private-error"); })
      .mockRejectedValueOnce(new Error("private-error"));
    const router = new UtteranceRouter(source, "both", mcp, createLogger("debug", (line) => lines.push(line)));
    router.on("utterance", slack);
    source.emit("utterance", { text: "hello", lang: "ja" });
    source.emit("utterance", { text: "hello", lang: "ja" });
    await Promise.resolve();
    expect(slack).toHaveBeenCalledTimes(2);
    expect(lines).toHaveLength(2); expect(lines.join("\n")).not.toContain("private-error");
  });
});
