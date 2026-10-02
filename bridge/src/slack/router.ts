import { createLogger, type Logger } from "../log.js";
import type { Utterance, UtteranceSource } from "./contracts.js";

export type UtteranceRoute = "mcp" | "slack" | "both";
export function loadUtteranceRoute(environment: NodeJS.ProcessEnv = process.env): UtteranceRoute {
  const route = environment.ROUTE || "mcp";
  if (route !== "mcp" && route !== "slack" && route !== "both") throw new Error("Invalid ROUTE");
  return route;
}

/** Present this source to SlackMirror; inject the MCP handler from the owning branch. */
export class UtteranceRouter implements UtteranceSource {
  private readonly slackListeners = new Set<(u: Utterance) => void>();
  private active = true;

  constructor(source: UtteranceSource, route: UtteranceRoute,
    mcp?: (u: Utterance) => void | Promise<void>, logger: Logger = createLogger()) {
    if (route !== "slack" && !mcp) throw new Error("MCP utterance handler is required for ROUTE");
    source.on("utterance", (u) => {
      if (!this.active) return;
      if (route !== "slack" && mcp) {
        try { void Promise.resolve(mcp(u)).catch(() => logger.error("mcp_utterance_failed")); }
        catch { logger.error("mcp_utterance_failed"); }
      }
      if (route !== "mcp") {
        for (const cb of this.slackListeners) {
          try { cb(u); } catch { logger.error("slack_utterance_handler_failed"); }
        }
      }
    });
  }

  on(_event: "utterance", cb: (u: Utterance) => void): void { this.slackListeners.add(cb); }
  dispose(): void { this.active = false; this.slackListeners.clear(); }
}
