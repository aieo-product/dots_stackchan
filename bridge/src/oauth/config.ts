import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface OAuthConfig {
  /** Canonical HTTPS MCP resource, including /mcp. */
  readonly publicUrl: string;
  readonly passcode: string;
  readonly storeDir: string;
  readonly allowedRedirectOrigins?: readonly string[];
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

export const DEFAULT_REDIRECT_ORIGINS = ["https://chatgpt.com"] as const;

// Reject invisible formatting in every piece of metadata that may appear in consent.
export function safeDisplay(value: string): boolean {
  return !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

export function redirectAllowed(uri: string, origins: readonly string[]): boolean {
  try { return safeDisplay(uri) && origins.includes(new URL(uri).origin); } catch { return false; }
}

export function validateOAuthConfig(config: OAuthConfig): OAuthConfig {
  let url: URL;
  try { url = new URL(config.publicUrl); } catch { throw new Error("Invalid MCP_PUBLIC_URL."); }
  if (!safeDisplay(config.publicUrl) || config.publicUrl.length > 2048 || url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      url.pathname !== "/mcp" || url.href !== `${url.origin}/mcp` || url.href !== config.publicUrl) {
    throw new Error("MCP_PUBLIC_URL must be a canonical HTTPS URL ending in /mcp.");
  }
  if (Buffer.byteLength(config.passcode) < 16 || Buffer.byteLength(config.passcode) > 1024 ||
      config.passcode.startsWith("keychain://")) {
    throw new Error("MCP_PASSCODE must be an injected passcode of 16–1024 bytes.");
  }
  if (!isAbsolute(config.storeDir)) throw new Error("OAUTH_STORE_DIR must be absolute.");
  const origins = config.allowedRedirectOrigins ?? DEFAULT_REDIRECT_ORIGINS;
  if (origins.length === 0 || origins.length > 20 || origins.some((origin) => {
    try {
      const url = new URL(origin);
      return !safeDisplay(origin) || origin.length > 2048 || url.protocol !== "https:" || url.origin !== origin;
    } catch { return true; }
  })) throw new Error("OAUTH_ALLOWED_REDIRECT_ORIGINS must contain canonical HTTPS origins.");
  return { ...config, allowedRedirectOrigins: [...new Set(origins)] };
}

export function readOAuthConfig(env: NodeJS.ProcessEnv = process.env): OAuthConfig {
  return validateOAuthConfig({
    allowedRedirectOrigins: env.OAUTH_ALLOWED_REDIRECT_ORIGINS?.split(",").map((value) => value.trim()),
    publicUrl: env.MCP_PUBLIC_URL ?? "",
    passcode: env.MCP_PASSCODE ?? "",
    storeDir: env.OAUTH_STORE_DIR ?? defaultStoreDirectory(env),
  });
}
