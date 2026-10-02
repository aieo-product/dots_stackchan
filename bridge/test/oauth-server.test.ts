import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, readFileSync, writeFileSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readOAuthConfig, validateOAuthConfig } from "../src/oauth/config.js";
import { validPkce } from "../src/oauth/crypto.js";
import { createOAuth, wrapMcpHandler } from "../src/oauth/index.js";
import { revokeOAuth } from "../src/oauth/revoke.js";
import { OAuthStore } from "../src/oauth/store.js";
import {
  approve, authorizationUrl, authorize, CHALLENGE, codeRequest, consentForm, harness, ISSUER,
  REDIRECT, refreshRequest, registerClient, request, RESOURCE, tokens, VERIFIER, type TokenResponse,
} from "./oauth-helpers.js";

const instances: ReturnType<typeof harness>[] = [];
afterEach(() => { instances.splice(0).forEach((instance) => instance.cleanup()); });
function setup() { const instance = harness(); instances.push(instance); return instance; }
async function mcp(instance: ReturnType<typeof harness>, token: string): Promise<Response> {
  return instance.handler(request("/mcp", undefined, { authorization: `Bearer ${token}` }));
}

describe("OAuth discovery and configuration", () => {
  it("publishes resource and authorization metadata and a discoverable 401", async () => {
    const h = setup();
    const challenge = await h.handler(request("/mcp"));
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/mcp", scope="stackchan"`);
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      expect(await (await h.handler(request(path))).json()).toMatchObject({ resource: RESOURCE, authorization_servers: [ISSUER], bearer_methods_supported: ["header"] });
    }
    expect(await (await h.handler(request("/.well-known/oauth-authorization-server"))).json()).toMatchObject({
      issuer: ISSUER, token_endpoint: `${ISSUER}/oauth/token`, registration_endpoint: `${ISSUER}/oauth/register`,
      code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"],
    });
    expect((await h.handler(request("/.well-known/oauth-protected-resource", {}))).status).toBe(405);
  });

  it("does not expose device or arbitrary handlers", async () => {
    const h = setup();
    for (const path of ["/device", "/", "/other"]) expect((await h.handler(request(path))).status).toBe(404);
    expect((await h.handler(request("/oauth/token"))).status).toBe(405);
    expect((await h.handler(request("/mcp?access_token=example"))).status).toBe(400);
    expect((await h.handler(request("/mcp", undefined, { origin: "https://example.org" }))).status).toBe(403);
  });

  it("validates HTTPS, canonical /mcp URL, injected passcode and private store path without echoing secrets", () => {
    const h = setup();
    expect(readOAuthConfig({ MCP_PUBLIC_URL: RESOURCE, MCP_PASSCODE: h.passcode, OAUTH_STORE_DIR: h.directory })).toEqual(h.config);
    for (const publicUrl of ["http://example.com/mcp", `${RESOURCE}/`, `${RESOURCE}?x=1`, `${RESOURCE}#x`, `${RESOURCE}?`, `${RESOURCE}#`, "https://example.com", "https://user:secret@example.com/mcp"]) {
      expect(() => validateOAuthConfig({ ...h.config, publicUrl })).toThrow("MCP_PUBLIC_URL");
    }
    for (const passcode of ["", "short", "keychain://MCP_PASSCODE", "x".repeat(1025)]) {
      expect(() => validateOAuthConfig({ ...h.config, passcode })).toThrow("MCP_PASSCODE");
    }
    expect(() => validateOAuthConfig({ ...h.config, storeDir: "relative" })).toThrow("OAUTH_STORE_DIR");
    expect(validPkce(VERIFIER, CHALLENGE)).toBe(true);
    expect(validPkce("a".repeat(42), CHALLENGE)).toBe(false);
    expect(validPkce("!".repeat(43), CHALLENGE)).toBe(false);
    expect(validPkce("b".repeat(43), CHALLENGE)).toBe(false);
  });
});

describe("Dynamic client registration", () => {
  it("accepts only public code clients with HTTPS redirects and imposes a persistent cap", async () => {
    const h = setup();
    const client = await registerClient(h.handler);
    expect(client).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const extra of [
      { redirect_uris: ["http://example.org/callback"] }, { redirect_uris: [`${REDIRECT}#fragment`] }, { redirect_uris: [`${REDIRECT}#`] },
      { redirect_uris: ["https://user:secret@example.org/callback"] }, { redirect_uris: [] }, { redirect_uris: ["https://example.org;default-src/callback"] },
      { token_endpoint_auth_method: "client_secret_post" }, { grant_types: ["refresh_token"] },
      { response_types: ["token"] }, { redirect_uris: [REDIRECT, REDIRECT] },
    ]) {
      const response = await h.handler(new Request(`${ISSUER}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [REDIRECT], ...extra }) }));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: expect.stringMatching(/^invalid_(client_metadata|redirect_uri)$/) });
    }
    for (let index = 1; index < 100; index++) await registerClient(h.handler);
    await expect(registerClient(h.handler)).rejects.toThrow("429");
    const restarted = createOAuth(h.config, h.options).wrap(async () => new Response());
    await expect(registerClient(restarted)).rejects.toThrow("429");
  });

  it("defaults DCR to authorization_code only per RFC 7591", async () => {
    const h = setup();
    const response = await h.handler(new Request(`${ISSUER}/oauth/register`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ redirect_uris: [REDIRECT] }),
    }));
    const registered = await response.json() as { client_id: string; grant_types: string[] };
    expect(registered.grant_types).toEqual(["authorization_code"]);
    expect((await tokens(h.handler, registered.client_id, h.passcode)).refresh_token).toBeUndefined();
  });

  it("rejects oversized, malformed and wrong-content-type registrations", async () => {
    const h = setup();
    for (const [body, status] of [["{", 400], ["x".repeat(8193), 413]] as const) {
      expect((await h.handler(new Request(`${ISSUER}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body }))).status).toBe(status);
    }
    expect((await h.handler(request("/oauth/register", {}))).status).toBe(415);
  });
});

describe("Authorization, consent and CSRF", () => {
  it("shows explicit consent with escaped metadata, CSP, secure browser binding and state/issuer echo", async () => {
    const h = setup();
    const client = await registerClient(h.handler, { client_name: '<script>alert("x")</script>' });
    const consent = await consentForm(h.handler, authorizationUrl(client));
    expect(consent.response.status).toBe(200);
    expect(consent.html).toContain("&lt;script&gt;");
    expect(consent.html).not.toContain("<script>");
    expect(consent.html).toContain("microphone");
    expect(consent.html).not.toContain(h.passcode);
    expect(consent.response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(consent.response.headers.get("content-security-policy")).toContain("form-action 'self' https://example.org;");
    expect(consent.response.headers.get("set-cookie")).toContain("Secure; HttpOnly; SameSite=Lax; Path=/");
    const response = await h.handler(request("/oauth/authorize", { transaction: consent.transaction, passcode: h.passcode, decision: "allow" }, { origin: ISSUER, cookie: consent.cookie }));
    expect(response.status).toBe(303);
    const callback = new URL(response.headers.get("location") ?? "");
    expect(callback.origin + callback.pathname).toBe("https://example.org/callback");
    expect(callback.searchParams.get("fixed")).toBe("1");
    expect(callback.searchParams.get("state")).toBe("test-state");
    expect(callback.searchParams.get("iss")).toBe(ISSUER);
    expect(callback.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it.each<Record<string, string>>([
    { redirect_uri: `${REDIRECT}&extra=1` }, { redirect_uri: "https://example.net/evil" }, { client_id: "unknown" },
    { response_type: "token" }, { code_challenge_method: "plain" }, { code_challenge: "short" },
    { resource: "https://example.net/mcp" }, { resource: "" }, { scope: "admin" },
  ])("rejects invalid authorization and redirects errors only to a validated return URI (%j)", async (extra) => {
    const h = setup();
    const client = await registerClient(h.handler);
    const response = await h.handler(new Request(authorizationUrl(client, extra)));
    if ("redirect_uri" in extra || "client_id" in extra) {
      expect(response.status).toBe(400);
      expect(response.headers.has("location")).toBe(false);
    } else {
      expect(response.status).toBe(303);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.origin + location.pathname).toBe("https://example.org/callback");
      expect(location.searchParams.has("error")).toBe(true);
      expect(location.searchParams.has("code")).toBe(false);
      expect(location.searchParams.get("state")).toBe("test-state");
    }
  });

  it("rejects duplicate and omitted PKCE parameters", async () => {
    const h = setup();
    const client = await registerClient(h.handler);
    const duplicate = `${authorizationUrl(client)}&client_id=${client}`;
    expect((await h.handler(new Request(duplicate))).status).toBe(400);
    const missing = new URL(authorizationUrl(client));
    missing.searchParams.delete("code_challenge_method");
    const rejected = await h.handler(new Request(missing));
    expect(rejected.status).toBe(303);
    expect(new URL(rejected.headers.get("location") ?? "").searchParams.get("error")).toBe("invalid_request");
  });

  it("requires the browser cookie and exact Origin and rejects form parameter injection", async () => {
    const h = setup();
    const client = await registerClient(h.handler);
    const consent = await consentForm(h.handler, authorizationUrl(client));
    const params = { transaction: consent.transaction, passcode: h.passcode, decision: "allow" };
    for (const headers of [{ cookie: consent.cookie }, { origin: ISSUER }, { origin: ISSUER, cookie: "__Host-dots-oauth=wrong" }, { origin: "https://example.net", cookie: consent.cookie }] as HeadersInit[]) {
      expect((await h.handler(request("/oauth/authorize", params, headers))).status).toBeGreaterThanOrEqual(400);
    }
    expect((await h.handler(request("/oauth/authorize", { ...params, redirect_uri: "https://example.net" }, { origin: ISSUER, cookie: consent.cookie }))).status).toBe(400);
    const success = await h.handler(request("/oauth/authorize", params, { origin: ISSUER, cookie: consent.cookie }));
    expect(success.status).toBe(303);
    expect((await h.handler(request("/oauth/authorize", params, { origin: ISSUER, cookie: consent.cookie }))).status).toBe(400);
  });

  it("allows denial without issuing a code and expires unused consent", async () => {
    const h = setup();
    const client = await registerClient(h.handler);
    const denial = await approve(h.handler, authorizationUrl(client), "", { decision: "deny" });
    const location = new URL(denial.headers.get("location") ?? "");
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.has("code")).toBe(false);
    const consent = await consentForm(h.handler, authorizationUrl(client));
    h.advance(600_000);
    expect((await h.handler(request("/oauth/authorize", { transaction: consent.transaction, passcode: h.passcode, decision: "allow" }, { origin: ISSUER, cookie: consent.cookie }))).status).toBe(400);
  });
});

describe("Tokens and persistent revocation", () => {
  it("issues one-hour resource-bound opaque tokens and accepts only Bearer headers", async () => {
    const h = setup();
    const client = await registerClient(h.handler);
    const token = await tokens(h.handler, client, h.passcode);
    expect(token).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "stackchan" });
    expect(token.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await mcp(h, token.access_token)).status).toBe(200);
    for (const authorization of ["Basic example", `Bearer ${token.refresh_token}`, `Bearer ${token.access_token} extra`, `Bearer ${randomBytes(32).toString("base64url")}`]) {
      const response = await h.handler(request("/mcp", undefined, { authorization }));
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
    }
    h.advance(3_600_000);
    expect((await mcp(h, token.access_token)).status).toBe(401);
  });

  it("enforces client, redirect, resource, verifier and one-use code; revokes on replay", async () => {
    const h = setup();
    const client = await registerClient(h.handler);
    const other = await registerClient(h.handler);
    const code = await authorize(h.handler, client, h.passcode);
    for (const extra of [{ client_id: other }, { redirect_uri: `${REDIRECT}&changed=1` }, { code_verifier: "b".repeat(43) }, { code_verifier: "" }, { resource: "https://example.net/mcp" }] as Record<string, string>[]) {
      expect((await h.handler(codeRequest(client, code, extra))).status).toBe(400);
    }
    const issued = await h.handler(codeRequest(client, code));
    expect(issued.status).toBe(200);
    const token = await issued.json() as TokenResponse;
    expect((await mcp(h, token.access_token)).status).toBe(200);
    expect((await h.handler(codeRequest(client, code))).status).toBe(400);
    expect((await mcp(h, token.access_token)).status).toBe(401);
    expect((await h.handler(refreshRequest(client, token.refresh_token ?? ""))).status).toBe(400);
  });

  it("expires unredeemed codes, requires resource and rejects alternate grants/client authentication", async () => {
    const h = setup();
    const client = await registerClient(h.handler);
    const code = await authorize(h.handler, client, h.passcode);
    h.advance(300_000);
    expect((await h.handler(codeRequest(client, code))).status).toBe(400);
    for (const extra of [{ resource: "" }, { grant_type: "password" }, { client_secret: "example" }, { scope: "admin" }] as Record<string, string>[]) {
      expect((await h.handler(codeRequest(client, code, extra))).status).toBeGreaterThanOrEqual(400);
    }
  });

  it("rejects duplicate token parameters and detects code replay after the original code expiry", async () => {
    const h = setup();
    const client = await registerClient(h.handler);
    const code = await authorize(h.handler, client, h.passcode);
    const normal = codeRequest(client, code);
    const body = await normal.text();
    const duplicate = new Request(normal.url, { method: "POST", headers: normal.headers, body: `${body}&resource=${encodeURIComponent(RESOURCE)}` });
    expect((await h.handler(duplicate)).status).toBe(400);
    const token = await (await h.handler(codeRequest(client, code))).json() as TokenResponse;
    h.advance(300_000);
    expect((await h.handler(codeRequest(client, code))).status).toBe(400);
    expect((await mcp(h, token.access_token)).status).toBe(401);
  });

  it("checks the stored token audience on every MCP request", async () => {
    const h = setup();
    const client = await registerClient(h.handler);
    const token = await tokens(h.handler, client, h.passcode);
    new OAuthStore(h.directory, RESOURCE).transaction((data) => {
      data.access[0].resource = "https://example.net/mcp";
    });
    expect((await mcp(h, token.access_token)).status).toBe(401);
  });

  it("serializes simultaneous code redemption", async () => {
    const h = setup();
    const client = await registerClient(h.handler);
    const code = await authorize(h.handler, client, h.passcode);
    const responses = await Promise.all([h.handler(codeRequest(client, code)), h.handler(codeRequest(client, code))]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    const token = await responses.find((response) => response.status === 200)?.json() as TokenResponse;
    expect((await mcp(h, token.access_token)).status).toBe(401);
  });

  it("rotates refresh tokens and revokes the whole family when an old refresh token is replayed", async () => {
    const h = setup();
    const client = await registerClient(h.handler);
    const initial = await tokens(h.handler, client, h.passcode);
    const refresh = initial.refresh_token ?? "";
    const rotated = await h.handler(refreshRequest(client, refresh));
    expect(rotated.status).toBe(200);
    const next = await rotated.json() as TokenResponse;
    expect(next.refresh_token).not.toBe(refresh);
    expect(next.access_token).not.toBe(initial.access_token);
    const other = await registerClient(h.handler);
    expect((await h.handler(refreshRequest(other, next.refresh_token ?? ""))).status).toBe(400);
    expect((await h.handler(refreshRequest(client, next.refresh_token ?? "", { resource: "https://example.net/mcp" }))).status).toBe(400);
    expect((await mcp(h, next.access_token)).status).toBe(200);
    const restarted = createOAuth(h.config, h.options).wrap(async () => new Response());
    expect((await restarted(refreshRequest(client, refresh))).status).toBe(400);
    expect((await mcp(h, next.access_token)).status).toBe(401);
    expect((await mcp(h, initial.access_token)).status).toBe(401);
    expect((await h.handler(refreshRequest(client, next.refresh_token ?? ""))).status).toBe(400);
  });

  it("expires the refresh family after 30 days without extending it on rotation", async () => {
    const h = setup();
    const client = await registerClient(h.handler);
    const initial = await tokens(h.handler, client, h.passcode);
    h.advance(29 * 24 * 60 * 60 * 1000);
    const next = await (await h.handler(refreshRequest(client, initial.refresh_token ?? ""))).json() as TokenResponse;
    h.advance(24 * 60 * 60 * 1000);
    expect((await h.handler(refreshRequest(client, next.refresh_token ?? ""))).status).toBe(400);
  });

  it("does not mint refresh tokens for clients registered for code only", async () => {
    const h = setup();
    const client = await registerClient(h.handler, { grant_types: ["authorization_code"] });
    const token = await tokens(h.handler, client, h.passcode);
    expect(token.refresh_token).toBeUndefined();
    expect((await mcp(h, token.access_token)).status).toBe(200);
  });

  it("stores only hashes, preserves tokens across restart and revokes without restart", async () => {
    const h = setup();
    const client = await registerClient(h.handler);
    const code = await authorize(h.handler, client, h.passcode);
    const token = await (await h.handler(codeRequest(client, code))).json() as TokenResponse;
    const file = join(h.directory, "store.json");
    const raw = readFileSync(file, "utf8");
    for (const secret of [client, code, token.access_token, token.refresh_token ?? "", h.passcode]) expect(raw).not.toContain(secret);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(lstatSync(h.directory).mode & 0o777).toBe(0o700);
    const handler = wrapMcpHandler(createOAuth(h.config, h.options), async () => new Response());
    expect((await handler(request("/mcp", undefined, { authorization: `Bearer ${token.access_token}` }))).status).toBe(200);
    revokeOAuth(h.directory);
    expect((await mcp(h, token.access_token)).status).toBe(401);
    expect((await h.handler(refreshRequest(client, token.refresh_token ?? ""))).status).toBe(400);
    expect((await h.handler(new Request(authorizationUrl(client)))).status).toBe(400);
    expect(() => createOAuth({ ...h.config, publicUrl: "https://example.net/mcp" }, h.options)).not.toThrow();
  });

  it("rejects symlinked store files and directories", async () => {
    const h = setup();
    const client = await registerClient(h.handler);
    const token = await tokens(h.handler, client, h.passcode);
    const file = join(h.directory, "store.json");
    const backup = join(h.directory, "backup.json");
    writeFileSync(backup, readFileSync(file), { mode: 0o600 });
    unlinkSync(file);
    symlinkSync(backup, file);
    expect((await mcp(h, token.access_token)).status).toBe(500);
    const link = join(h.directory, "linked-directory");
    symlinkSync(h.directory, link);
    expect(() => new OAuthStore(link, RESOURCE)).toThrow("0700");
  });

  it("fails closed on corrupt files, unsafe permissions, resource changes and a concurrent writer", async () => {
    const h = setup();
    const client = await registerClient(h.handler);
    const token = await tokens(h.handler, client, h.passcode);
    expect(() => createOAuth({ ...h.config, publicUrl: "https://example.net/mcp" }, h.options)).toThrow();
    const file = join(h.directory, "store.json");
    chmodSync(file, 0o644);
    expect((await mcp(h, token.access_token)).status).toBe(500);
    chmodSync(file, 0o600);
    writeFileSync(join(h.directory, "transaction.lock"), "", { mode: 0o600 });
    expect((await h.handler(codeRequest(client, "unknown"))).status).toBe(500);
    writeFileSync(file, "{}");
    expect((await mcp(h, token.access_token)).status).toBe(500);
    chmodSync(h.directory, 0o755);
    expect(() => new OAuthStore(h.directory, RESOURCE)).toThrow("0700");
  });
});

describe("Lockout and redacted access events", () => {
  it("blocks both the client and global authorization after five wrong passcodes for 15 minutes, across restarts", async () => {
    const h = setup();
    const first = await registerClient(h.handler);
    const second = await registerClient(h.handler);
    for (let index = 0; index < 5; index++) {
      const response = await approve(h.handler, authorizationUrl(index % 2 ? second : first), "wrong");
      expect(response.status).toBe(index === 4 ? 429 : 403);
    }
    for (const client of [first, second, await registerClient(h.handler)]) {
      const response = await h.handler(new Request(authorizationUrl(client)));
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("900");
    }
    const restarted = createOAuth(h.config, h.options).wrap(async () => new Response());
    expect((await restarted(new Request(authorizationUrl(first)))).status).toBe(429);
    h.advance(899_999);
    expect((await restarted(new Request(authorizationUrl(first)))).status).toBe(429);
    h.advance(1);
    expect((await approve(restarted, authorizationUrl(first), h.passcode)).status).toBe(303);
  });

  it("blocks a previously opened consent form even with the correct passcode", async () => {
    const h = setup();
    const client = await registerClient(h.handler);
    const pending = await consentForm(h.handler, authorizationUrl(client));
    for (let index = 0; index < 5; index++) await approve(h.handler, authorizationUrl(client), "wrong");
    const response = await h.handler(request("/oauth/authorize", { transaction: pending.transaction, passcode: h.passcode, decision: "allow" }, { origin: ISSUER, cookie: pending.cookie }));
    expect(response.status).toBe(429);
    expect(response.headers.has("location")).toBe(false);
  });

  it("does not count forged requests, resets an old failure window, and keeps lockouts during revocation", async () => {
    const h = setup();
    const client = await registerClient(h.handler);
    for (let index = 0; index < 5; index++) await h.handler(request("/oauth/authorize", { transaction: "forged", passcode: "wrong", decision: "allow" }, { origin: ISSUER }));
    for (let index = 0; index < 4; index++) expect((await approve(h.handler, authorizationUrl(client), "wrong")).status).toBe(403);
    h.advance(900_000);
    expect((await approve(h.handler, authorizationUrl(client), "wrong")).status).toBe(403);
    for (let index = 0; index < 4; index++) await approve(h.handler, authorizationUrl(client), "wrong");
    revokeOAuth(h.directory);
    const newClient = await registerClient(h.handler);
    expect((await h.handler(new Request(authorizationUrl(newClient)))).status).toBe(429);
  });

  it("logs only fixed route/method/status labels and tolerates a failing log sink", async () => {
    const h = setup();
    const client = await registerClient(h.handler);
    const token = await tokens(h.handler, client, h.passcode);
    await mcp(h, token.access_token);
    await h.handler(request("/private-path?secret=hidden", undefined, { "x-forwarded-for": "192.0.2.1" }));
    const log = JSON.stringify(h.events);
    for (const secret of [h.passcode, client, token.access_token, token.refresh_token ?? "", "192.0.2.1", ISSUER, "private-path", "hidden"]) expect(log).not.toContain(secret);
    expect(h.events.at(-1)).toEqual({ route: "other", method: "GET", status: 404 });
    const brokenLog = createOAuth(h.config, { log: () => { throw new Error("sink"); } }).wrap(async () => new Response());
    expect((await brokenLog(request("/mcp"))).status).toBe(401);
  });
});
