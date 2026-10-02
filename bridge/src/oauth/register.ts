import { z } from "zod";

import { redirectAllowed, safeDisplay } from "./config.js";
import { hash, randomSecret } from "./crypto.js";
import { boundedBody, json, OAuthError } from "./protocol.js";
import { prune, type OAuthStore } from "./store.js";

function httpsRedirect(value: string): boolean {
  try {
    const url = new URL(value);
    const safeHost = /^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])$/i.test(url.hostname);
    return safeDisplay(value) && safeHost && url.protocol === "https:" && !url.username && !url.password && !value.includes("#") && url.href === value;
  } catch { return false; }
}

const registration = z.object({
  redirect_uris: z.array(z.string().max(2048).refine(httpsRedirect)).min(1).max(10),
  client_name: z.string().min(1).max(120).refine(safeDisplay).default("MCP client"),
  token_endpoint_auth_method: z.literal("none").default("none"),
  grant_types: z.array(z.enum(["authorization_code", "refresh_token"]))
    .min(1).max(2).default(["authorization_code"]),
  response_types: z.array(z.literal("code")).length(1).default(["code"]),
});

export async function register(request: Request, store: OAuthStore, now: number, origins: readonly string[]): Promise<Response> {
  if (request.headers.get("content-type")?.split(";")[0].trim() !== "application/json") {
    throw new OAuthError("invalid_client_metadata", 415);
  }
  let input: unknown;
  try { input = JSON.parse(await boundedBody(request)); } catch (error) {
    if (error instanceof OAuthError) throw error;
    throw new OAuthError("invalid_client_metadata");
  }
  const parsed = registration.safeParse(input);
  if (!parsed.success) {
    const invalidRedirect = parsed.error.issues.some((issue) => issue.code === "custom" && issue.path[0] === "redirect_uris");
    throw new OAuthError(invalidRedirect ? "invalid_redirect_uri" : "invalid_client_metadata");
  }
  const metadata = parsed.data;
  if (!metadata.grant_types.includes("authorization_code") ||
      new Set(metadata.grant_types).size !== metadata.grant_types.length ||
      new Set(metadata.redirect_uris).size !== metadata.redirect_uris.length) {
    throw new OAuthError("invalid_client_metadata");
  }
  if (metadata.redirect_uris.some((uri) => !redirectAllowed(uri, origins))) throw new OAuthError("invalid_redirect_uri");
  const clientId = randomSecret();
  await store.transaction((data) => {
    prune(data, now);
    if (data.clients.length >= 100) {
      const oldest = data.clients.filter((entry) => !entry.used).sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest) {
        data.clients = data.clients.filter((entry) => entry !== oldest);
        data.pending = data.pending.filter((entry) => entry.clientHash !== oldest.hash);
        data.codes = data.codes.filter((entry) => entry.clientHash !== oldest.hash);
      }
    }
    if (data.clients.length >= 100) throw new OAuthError("registration_limit", 429);
    data.clients.push({ createdAt: now, used: false, hash: hash(clientId), name: metadata.client_name,
      redirectUris: metadata.redirect_uris, refresh: metadata.grant_types.includes("refresh_token") });
  });
  return json({ ...metadata, client_id: clientId, client_id_issued_at: Math.floor(now / 1000) }, 201);
}
