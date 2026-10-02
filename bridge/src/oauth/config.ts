import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface OAuthConfig {
  /** Canonical HTTPS MCP resource, including /mcp. */
  readonly publicUrl: string;
  readonly passcode: string;
  readonly storeDir: string;
}

export function defaultStoreDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "dots-stackchan", "oauth");
  }
  if (process.platform === "win32") {
    return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "dots-stackchan", "oauth");
  }
  return join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "dots-stackchan", "oauth");
}

export function validateOAuthConfig(config: OAuthConfig): OAuthConfig {
  let url: URL;
  try { url = new URL(config.publicUrl); } catch { throw new Error("Invalid MCP_PUBLIC_URL."); }
  if (config.publicUrl.length > 2048 || url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      url.pathname !== "/mcp" || url.href !== `${url.origin}/mcp` || url.href !== config.publicUrl) {
    throw new Error("MCP_PUBLIC_URL must be a canonical HTTPS URL ending in /mcp.");
  }
  if (Buffer.byteLength(config.passcode) < 16 || Buffer.byteLength(config.passcode) > 1024 ||
      config.passcode.startsWith("keychain://")) {
    throw new Error("MCP_PASSCODE must be an injected passcode of 16–1024 bytes.");
  }
  if (!isAbsolute(config.storeDir)) throw new Error("OAUTH_STORE_DIR must be absolute.");
  return config;
}

export function readOAuthConfig(env: NodeJS.ProcessEnv = process.env): OAuthConfig {
  return validateOAuthConfig({
    publicUrl: env.MCP_PUBLIC_URL ?? "",
    passcode: env.MCP_PASSCODE ?? "",
    storeDir: env.OAUTH_STORE_DIR ?? defaultStoreDirectory(env),
  });
}
