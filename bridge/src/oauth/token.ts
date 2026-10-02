import { createHmac } from "node:crypto";

import { equalHash, hash, randomSecret, validPkce } from "./crypto.js";
import { canonicalResource, form, json, OAuthError, required, SCOPE, validateScope } from "./protocol.js";
import { prune, revokeFamily, type OAuthStore, type StoreData } from "./store.js";

const ACCESS_MS = 60 * 60 * 1000;
const REFRESH_MS = 30 * 24 * 60 * 60 * 1000;

interface TokenPair { access: string; refresh?: string }

function response(pair: TokenPair, expiresIn = ACCESS_MS / 1000): Response {
  return json({ access_token: pair.access, token_type: "Bearer", expires_in: expiresIn,
    scope: SCOPE, ...(pair.refresh ? { refresh_token: pair.refresh } : {}) });
}

// The old secret plus a private random salt reproduces a retry response, including after restart.
// Persist only salt and hashes: no plaintext or encrypted bearer tokens are stored.
function rotatedPair(old: string, salt: string, family: string): TokenPair {
  const derive = (purpose: string) => createHmac("sha256", old)
    .update(JSON.stringify(["dots-oauth-rotation", salt, family, purpose])).digest("base64url");
  return { access: derive("access"), refresh: derive("refresh") };
}

function issue(data: StoreData, clientHash: string, family: string, now: number, refreshExpires?: number,
  pair: TokenPair = { access: randomSecret(), ...(refreshExpires !== undefined ? { refresh: randomSecret() } : {}) }): Response {
  data.access.push({ hash: hash(pair.access), clientHash, family, resource: data.resource, expires: now + ACCESS_MS, used: false });
  if (refreshExpires !== undefined && pair.refresh) {
    data.refresh.push({ hash: hash(pair.refresh), clientHash, family, resource: data.resource, expires: refreshExpires, used: false });
  }
  return response(pair);
}

export async function exchange(request: Request, store: OAuthStore, resource: string, now: number): Promise<Response> {
  const params = await form(request);
  if (request.headers.has("authorization")) throw new OAuthError("invalid_request");
  if (params.has("client_secret")) throw new OAuthError("invalid_client");
  const clientHash = hash(required(params, "client_id"));
  if (params.has("resource") && !canonicalResource(required(params, "resource"), resource)) throw new OAuthError("invalid_target");
  validateScope(params.get("scope"));
  const type = required(params, "grant_type");
  if (type !== "authorization_code" && type !== "refresh_token") throw new OAuthError("unsupported_grant_type");
  return store.transaction((data) => {
    prune(data, now);
    const capacityReached = data.access.length >= 4096 || data.refresh.length >= 4096;
    const client = data.clients.find((entry) => equalHash(entry.hash, clientHash));
    if (!client) return json({ error: "invalid_client" }, 400);
    if (type === "authorization_code") {
      const codeHash = hash(required(params, "code"));
      const code = data.codes.find((entry) => equalHash(entry.hash, codeHash));
      if (!code || !equalHash(code.clientHash, clientHash) || code.resource !== resource ||
          code.redirectUri !== required(params, "redirect_uri") || !validPkce(required(params, "code_verifier"), code.challenge)) {
        return json({ error: "invalid_grant" }, 400);
      }
      if (code.family !== null) {
        revokeFamily(data, code.family);
        return json({ error: "invalid_grant" }, 400);
      }
      // Preserve a tombstone so code replay also revokes tokens already minted.
      if (capacityReached) return json({ error: "temporarily_unavailable" }, 429);
      client.used = true;
      code.family = hash(randomSecret());
      code.expires = now + ACCESS_MS;
      return issue(data, clientHash, code.family, now, client.refresh ? now + REFRESH_MS : undefined);
    }
    const rawRefresh = required(params, "refresh_token");
    const refreshHash = hash(rawRefresh);
    const token = data.refresh.find((entry) => equalHash(entry.hash, refreshHash));
    if (!client.refresh || !token || !equalHash(token.clientHash, clientHash) || token.resource !== resource) {
      return json({ error: "invalid_grant" }, 400);
    }
    if (token.used) {
      const next = data.refresh.find((entry) => entry.hash === token.replacement && entry.family === token.family && !entry.used);
      if (next && token.rotatedAt !== undefined && token.rotationSalt && now >= token.rotatedAt && now - token.rotatedAt < 10_000) {
        const pair = rotatedPair(rawRefresh, token.rotationSalt, token.family);
        if (hash(pair.refresh ?? "") === next.hash && data.access.some((entry) => entry.hash === hash(pair.access) && entry.family === token.family)) {
          return response(pair, Math.ceil((token.rotatedAt + ACCESS_MS - now) / 1000));
        }
      }
      revokeFamily(data, token.family);
      return json({ error: "invalid_grant" }, 400);
    }
    if (capacityReached) return json({ error: "temporarily_unavailable" }, 429);
    client.used = true;
    token.used = true;
    token.rotatedAt = now;
    token.rotationSalt = hash(randomSecret());
    const pair = rotatedPair(rawRefresh, token.rotationSalt, token.family);
    token.replacement = hash(pair.refresh ?? "");
    return issue(data, clientHash, token.family, now, token.expires, pair);
  });
}

export function verifyAccess(store: OAuthStore, authorization: string | null, resource: string, now: number): boolean {
  if (!authorization || !/^Bearer [A-Za-z0-9_-]{43}$/i.test(authorization)) return false;
  const tokenHash = hash(authorization.slice(7));
  return store.validAccess(tokenHash, resource, now);
}
