import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOAuth, type AccessEvent, type HttpHandler } from "../src/oauth/index.js";

export const RESOURCE = "https://example.com:8443/mcp";
export const ISSUER = "https://example.com:8443";
export const REDIRECT = "https://example.org/callback?fixed=1";
export const VERIFIER = "a".repeat(43);
export const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope: string;
}

export function harness() {
  const directory = mkdtempSync(join(tmpdir(), "dots-oauth-test-"));
  const passcode = randomBytes(32).toString("base64url");
  const events: AccessEvent[] = [];
  let time = 1_800_000_000_000;
  const config = { publicUrl: RESOURCE, passcode, storeDir: directory, allowedRedirectOrigins: ["https://example.org"] };
  const options = { now: () => time, log: (event: AccessEvent) => { events.push(event); } };
  const oauth = createOAuth(config, options);
  const handler = oauth.wrap(async () => new Response("protected"));
  return {
    config, options, oauth, handler, events, directory, passcode,
    now: () => time,
    advance: (ms: number) => { time += ms; },
    cleanup: () => { rmSync(directory, { recursive: true, force: true }); },
  };
}

export function request(path: string, params?: Record<string, string>, headers: HeadersInit = {}): Request {
  return new Request(`${ISSUER}${path}`, params === undefined ? { headers } : {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(params),
  });
}

export async function registerClient(handler: HttpHandler, extra: Record<string, unknown> = {}): Promise<string> {
  const response = await handler(new Request(`${ISSUER}/oauth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token"], ...extra }),
  }));
  if (response.status !== 201) throw new Error(`Registration failed: ${response.status}`);
  const client = await response.json() as { client_id: string };
  return client.client_id;
}

export function authorizationUrl(client: string, extra: Record<string, string> = {}): string {
  return `${ISSUER}/oauth/authorize?${new URLSearchParams({
    client_id: client, redirect_uri: REDIRECT, response_type: "code", code_challenge_method: "S256",
    code_challenge: CHALLENGE, resource: RESOURCE, scope: "stackchan", state: "test-state", ...extra,
  })}`;
}

export async function consentForm(handler: HttpHandler, url: string): Promise<{ transaction: string; cookie: string; response: Response; html: string }> {
  const response = await handler(new Request(url));
  const html = await response.text();
  return {
    response, html, transaction: /name="transaction" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1] ?? "",
    cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "",
  };
}

export async function approve(handler: HttpHandler, url: string, passcode: string, extra: Record<string, string> = {}): Promise<Response> {
  const form = await consentForm(handler, url);
  return handler(request("/oauth/authorize", { transaction: form.transaction, passcode, decision: "allow", ...extra }, { origin: ISSUER, cookie: form.cookie }));
}

export async function authorize(handler: HttpHandler, client: string, passcode: string): Promise<string> {
  const response = await approve(handler, authorizationUrl(client), passcode);
  const location = response.headers.get("location");
  if (!location) throw new Error(`Authorization failed: ${response.status}`);
  return new URL(location).searchParams.get("code") ?? "";
}

export function codeRequest(client: string, code: string, extra: Record<string, string> = {}): Request {
  return request("/oauth/token", { grant_type: "authorization_code", client_id: client, code, code_verifier: VERIFIER, redirect_uri: REDIRECT, resource: RESOURCE, ...extra });
}

export function refreshRequest(client: string, refresh: string, extra: Record<string, string> = {}): Request {
  return request("/oauth/token", { grant_type: "refresh_token", client_id: client, refresh_token: refresh, resource: RESOURCE, ...extra });
}

export async function tokens(handler: HttpHandler, client: string, passcode: string): Promise<TokenResponse> {
  const code = await authorize(handler, client, passcode);
  return await (await handler(codeRequest(client, code))).json() as TokenResponse;
}
