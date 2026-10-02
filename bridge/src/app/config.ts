import { z } from "zod";
import { loadConfig } from "../config.js";
import { mcpConfigSchema } from "../mcp/config.js";
import { notificationConfigSchema } from "../notify/config.js";
import { readOAuthConfig } from "../oauth/config.js";
import { readEventsConfig } from "../events/config.js";
import { loadSlackConfig } from "../slack/config.js";
import { loadUtteranceRoute } from "../slack/router.js";
import { ttsEnvSchema } from "../tts/config.js";

/** Validate every service before opening sockets; errors contain setting names only. */
export function loadAppConfig(env: NodeJS.ProcessEnv = process.env) {
  const errors: string[] = [];
  function read<T>(label: string, loader: () => T): T | undefined {
    try { return loader(); }
    catch (error) {
      const fields = error instanceof z.ZodError
        ? [...new Set(error.issues.map(issue => String(issue.path[0] ?? label)))].join(", ")
        : error instanceof Error && /^(Invalid bridge configuration:|Invalid Slack configuration:)/.test(error.message)
          ? error.message : label;
      errors.push(fields);
      return undefined;
    }
  }
  const bridge = read("DEVICE_PSK / BRIDGE_* / STT_*", () => loadConfig(env));
  const tts = read("TTS_* / VOICE_MODE", () => ttsEnvSchema.parse(env));
  const mcp = read("MCP_PORT / MCP_HOST", () => mcpConfigSchema.parse({ MCP_PORT: "8791", ...env }));
  const localPort = read("MCP_LOCAL_PORT", () => z.coerce.number().int().min(1).max(65535).parse(env.MCP_LOCAL_PORT ?? "8792"));
  const notify = read("QUIET_HOURS / NOTIFY_*", () => notificationConfigSchema.parse(env));
  const events = read("EVENTS_ENABLED / EVENTS_SEND / EVENTS_STORE_DIR / EVENTS_SECRET_KEY", () => readEventsConfig(env));
  const slack = read("SLACK_ENABLED / SLACK_*", () => loadSlackConfig(env));
  const route = read("ROUTE", () => loadUtteranceRoute(env));
  const oauth = env.MCP_PUBLIC_URL ? read("MCP_PUBLIC_URL / MCP_PASSCODE / OAUTH_*", () => readOAuthConfig(env)) : undefined;
  if (bridge?.devicePsk.startsWith("keychain://")) errors.push("DEVICE_PSK must be injected");
  if (bridge && ["openai-realtime", "openai-batch"].includes(bridge.sttEngine) &&
      (!bridge.openaiApiKey || bridge.openaiApiKey.startsWith("keychain://"))) errors.push("OPENAI_API_KEY must be injected for STT");
  if (tts?.VOICE_MODE === "bridge" && [tts.TTS_ENGINE, tts.NOTIFY_TTS_ENGINE].includes("openai") &&
      (!bridge?.openaiApiKey || bridge.openaiApiKey.startsWith("keychain://"))) errors.push("OPENAI_API_KEY must be injected for TTS");
  if (bridge?.openaiApiKey?.startsWith("keychain://")) errors.push("OPENAI_API_KEY must be injected");
  if (env.LOCAL_TTS_TOKEN?.startsWith("keychain://")) errors.push("LOCAL_TTS_TOKEN must be injected");
  if (route !== "mcp" && !slack?.enabled) errors.push("SLACK_ENABLED is required for ROUTE");
  if (errors.length || !bridge || !tts || !mcp || !notify || !events || !slack || !route || !localPort) {
    throw new Error(`Invalid application configuration: ${errors.join("; ")}`);
  }
  return { bridge, tts, mcp, localPort, notify, events, slack, route, oauth, localTtsToken: env.LOCAL_TTS_TOKEN };
}

export type AppConfig = ReturnType<typeof loadAppConfig>;
