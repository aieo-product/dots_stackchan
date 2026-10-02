import { equalHash, hash, randomSecret } from "./crypto.js";
import { failedPasscode, isBlocked } from "./lockout.js";
import { canonicalResource, form, json, OAuthError, required, uniqueParams, validateScope } from "./protocol.js";
import { prune, type Grant, type OAuthStore } from "./store.js";

const COOKIE = "__Host-dots-oauth";
const REQUEST_MS = 10 * 60 * 1000;

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? "");
}

function consent(transaction: string, cookie: string, name: string, redirect: string): Response {
  // Browsers can enforce form-action on the POST redirect as well as its initial destination.
  const returnOrigin = new URL(redirect).origin;
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Authorize Stack-chan</title>
<h1>Authorize Stack-chan</h1><p>Client: ${escape(name)}</p><p>Return to: ${escape(redirect)}</p>
<p>Allow this client to speak, change expressions, move the head, send notifications, read status and listen to the microphone.</p>
<p>Only approve a client and return address you recognize.</p>
<form method="post" action="/oauth/authorize"><input type="hidden" name="transaction" value="${transaction}">
<label>Passcode <input type="password" name="passcode" required maxlength="1024" autocomplete="off"></label>
<button type="submit" name="decision" value="allow">Allow</button><button type="submit" name="decision" value="deny" formnovalidate>Deny</button></form></html>`, {
    headers: {
      "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "pragma": "no-cache",
      "content-security-policy": `default-src 'none'; form-action 'self' ${returnOrigin}; base-uri 'none'; frame-ancestors 'none'`,
      "x-frame-options": "DENY", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff",
      "set-cookie": `${COOKIE}=${cookie}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`,
    },
  });
}

function callback(grant: Grant, issuer: string, result: { code: string } | { error: string }): Response {
  const url = new URL(grant.redirectUri);
  for (const key of ["code", "error", "state", "iss"]) url.searchParams.delete(key);
  for (const [key, value] of Object.entries(result)) url.searchParams.set(key, value);
  if (grant.state !== null) url.searchParams.set("state", grant.state);
  url.searchParams.set("iss", issuer);
  return new Response(null, { status: 303, headers: { location: url.href, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}

function blocked(ms: number): Response {
  return json({ error: "temporarily_unavailable" }, 429, { "retry-after": String(Math.ceil(ms / 1000)) });
}

export function beginAuthorization(request: Request, store: OAuthStore, resource: string, now: number): Response {
  const params = uniqueParams(new URL(request.url).searchParams);
  const clientHash = hash(required(params, "client_id"));
  const redirectUri = required(params, "redirect_uri");
  const transaction = randomSecret();
  const cookie = randomSecret();
  return store.transaction((data) => {
    prune(data, now);
    const client = data.clients.find((entry) => equalHash(entry.hash, clientHash));
    if (!client || !client.redirectUris.includes(redirectUri)) throw new OAuthError("invalid_request");
    const remaining = isBlocked(data, clientHash, now);
    if (remaining) return blocked(remaining);
    if ((params.get("state")?.length ?? 0) > 1024) throw new OAuthError("invalid_request");
    const grant: Grant = { clientHash, redirectUri, challenge: params.get("code_challenge") ?? "", state: params.get("state"), resource };
    // OAuth errors may redirect only after validating the registered client and exact return URI.
    try {
      if (required(params, "response_type") !== "code") throw new OAuthError("unsupported_response_type");
      if (params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(grant.challenge)) {
        throw new OAuthError("invalid_request");
      }
      if (!canonicalResource(required(params, "resource"), resource)) throw new OAuthError("invalid_target");
      validateScope(params.get("scope"));
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
      return callback(grant, new URL(resource).origin, { error: error.code });
    }
    if (data.pending.length >= 256) return callback(grant, new URL(resource).origin, { error: "temporarily_unavailable" });
    data.pending.push({ hash: hash(transaction), cookieHash: hash(cookie), expires: now + REQUEST_MS,
      clientHash, redirectUri, challenge: required(params, "code_challenge"), state: params.get("state"), resource });
    return consent(transaction, cookie, client.name, redirectUri);
  });
}

export async function finishAuthorization(
  request: Request, store: OAuthStore, issuer: string, now: number,
  checkPasscode: (candidate: string) => boolean,
): Promise<Response> {
  if (request.headers.get("origin") !== issuer) throw new OAuthError("invalid_request");
  const params = await form(request);
  if ([...params.keys()].some((key) => !["transaction", "passcode", "decision"].includes(key))) throw new OAuthError("invalid_request");
  const cookies = (request.headers.get("cookie") ?? "").split(";").map((value) => value.trim()).filter((value) => value.startsWith(`${COOKIE}=`));
  if (cookies.length !== 1) throw new OAuthError("invalid_request");
  const cookieHash = hash(cookies[0].slice(COOKIE.length + 1));
  const transactionHash = hash(required(params, "transaction"));
  const decision = params.get("decision");
  if (decision !== "allow" && decision !== "deny") throw new OAuthError("invalid_request");
  return store.transaction((data) => {
    prune(data, now);
    const grant = data.pending.find((entry) => equalHash(entry.hash, transactionHash));
    if (!grant || !equalHash(grant.cookieHash, cookieHash)) throw new OAuthError("invalid_request");
    const remaining = isBlocked(data, grant.clientHash, now);
    if (remaining) return blocked(remaining);
    // A form submission is single-use, including wrong passcodes. Begin again to retry.
    data.pending = data.pending.filter((entry) => entry !== grant);
    if (decision === "deny") return callback(grant, issuer, { error: "access_denied" });
    if (!checkPasscode(params.get("passcode") ?? "")) {
      const locked = failedPasscode(data, grant.clientHash, now);
      return locked ? blocked(15 * 60 * 1000) : json({ error: "access_denied" }, 403);
    }
    if (data.codes.length >= 256) return json({ error: "temporarily_unavailable" }, 429);
    const code = randomSecret();
    data.codes.push({ hash: hash(code), clientHash: grant.clientHash, redirectUri: grant.redirectUri,
      challenge: grant.challenge, state: null, resource: grant.resource, expires: now + 5 * 60 * 1000, family: null });
    return callback(grant, issuer, { code });
  });
}
