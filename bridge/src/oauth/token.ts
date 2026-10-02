import { equalHash, hash, randomSecret, validPkce } from "./crypto.js";
import { canonicalResource, form, json, OAuthError, required, SCOPE, validateScope } from "./protocol.js";
import { prune, revokeFamily, type OAuthStore, type StoreData } from "./store.js";

const ACCESS_MS = 60 * 60 * 1000;
const REFRESH_MS = 30 * 24 * 60 * 60 * 1000;

function issue(data: StoreData, clientHash: string, family: string, now: number, refreshExpires?: number): Response {
  const accessToken = randomSecret();
  data.access.push({ hash: hash(accessToken), clientHash, family, resource: data.resource, expires: now + ACCESS_MS, used: false });
  let refreshToken: string | undefined;
  if (refreshExpires !== undefined) {
    refreshToken = randomSecret();
    data.refresh.push({ hash: hash(refreshToken), clientHash, family, resource: data.resource, expires: refreshExpires, used: false });
  }
  return json({ access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_MS / 1000,
    scope: SCOPE, ...(refreshToken ? { refresh_token: refreshToken } : {}) });
}

export async function exchange(request: Request, store: OAuthStore, resource: string, now: number): Promise<Response> {
  const params = await form(request);
  if (request.headers.has("authorization")) throw new OAuthError("invalid_request");
  if (params.has("client_secret")) throw new OAuthError("invalid_client");
  const clientHash = hash(required(params, "client_id"));
  if (!canonicalResource(required(params, "resource"), resource)) throw new OAuthError("invalid_target");
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
      code.family = hash(randomSecret());
      code.expires = now + ACCESS_MS;
      return issue(data, clientHash, code.family, now, client.refresh ? now + REFRESH_MS : undefined);
    }
    const refreshHash = hash(required(params, "refresh_token"));
    const token = data.refresh.find((entry) => equalHash(entry.hash, refreshHash));
    if (!client.refresh || !token || !equalHash(token.clientHash, clientHash) || token.resource !== resource) {
      return json({ error: "invalid_grant" }, 400);
    }
    if (token.used) {
      revokeFamily(data, token.family);
      return json({ error: "invalid_grant" }, 400);
    }
    if (capacityReached) return json({ error: "temporarily_unavailable" }, 429);
    token.used = true;
    return issue(data, clientHash, token.family, now, token.expires);
  });
}

export function verifyAccess(store: OAuthStore, authorization: string | null, resource: string, now: number): boolean {
  if (!authorization || !/^Bearer [A-Za-z0-9_-]{43}$/i.test(authorization)) return false;
  const tokenHash = hash(authorization.slice(7));
  return store.read().access.some((token) => equalHash(token.hash, tokenHash) && token.resource === resource && token.expires > now);
}
