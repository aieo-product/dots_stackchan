import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, expect, it, vi } from "vitest";

import { DEFAULT_REDIRECT_ORIGINS, readOAuthConfig, validateOAuthConfig } from "../src/oauth/config.js";
import { hash } from "../src/oauth/crypto.js";
import { createOAuth } from "../src/oauth/index.js";
import { OAuthStore } from "../src/oauth/store.js";
import { unlockOAuth } from "../src/oauth/unlock.js";
import { approve, authorizationUrl, authorize, codeRequest, consentForm, harness, ISSUER, REDIRECT,
  refreshRequest, registerClient, request, RESOURCE, tokens, type TokenResponse } from "./oauth-helpers.js";

beforeAll(() => {
  const build = spawnSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"], { encoding: "utf8" });
  expect(build.status).toBe(0);
}, 120_000);

const fixtures: ReturnType<typeof harness>[] = [];
afterEach(() => { vi.restoreAllMocks(); fixtures.splice(0).forEach((h) => h.cleanup()); });
function setup() { const h = harness(); fixtures.push(h); return h; }
async function registration(h: ReturnType<typeof harness>, metadata: Record<string, unknown>): Promise<Response> {
  return h.handler(new Request(`${ISSUER}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT], ...metadata }) }));
}

it("H1: retains a same-origin consent POST Origin and never accepts opaque null origins", async () => {
  const h = setup();
  const client = await registerClient(h.handler);
  const consent = await consentForm(h.handler, authorizationUrl(client));
  expect(consent.response.headers.get("referrer-policy")).toBe("same-origin");
  const response = await h.handler(request("/oauth/authorize", { transaction: consent.transaction, decision: "allow", passcode: h.passcode },
    { origin: "null", cookie: consent.cookie }));
  expect(response.status).toBe(403);
  const success = await approve(h.handler, authorizationUrl(client), h.passcode);
  expect(success.status).toBe(303);
  expect(success.headers.get("referrer-policy")).toBe("no-referrer");
});

it("M1: defaults to ChatGPT's origin, validates configuration and rejects every outside redirect", async () => {
  const h = setup();
  expect(DEFAULT_REDIRECT_ORIGINS).toEqual(["https://chatgpt.com"]);
  expect(readOAuthConfig({ MCP_PUBLIC_URL: RESOURCE, MCP_PASSCODE: h.passcode, OAUTH_STORE_DIR: h.directory,
    OAUTH_ALLOWED_REDIRECT_ORIGINS: " https://example.org, https://example.net " }).allowedRedirectOrigins)
    .toEqual(["https://example.org", "https://example.net"]);
  for (const origins of [[], ["http://example.org"], ["https://example.org/"], ["https://example.org/callback"], ["null"]]) {
    expect(() => validateOAuthConfig({ ...h.config, allowedRedirectOrigins: origins })).toThrow("OAUTH_ALLOWED_REDIRECT_ORIGINS");
  }
  for (const uri of ["https://example.net/callback", "https://example.org.evil.example/callback", "https://example.org:8443/callback"]) {
    const response = await registration(h, { redirect_uris: [REDIRECT, uri] });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_redirect_uri" });
  }
  expect(new OAuthStore(h.directory, RESOURCE).read().clients).toHaveLength(0);
  const defaults = createOAuth({ ...h.config, allowedRedirectOrigins: undefined }, h.options).wrap(async () => new Response());
  expect(await registerClient(defaults, { redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"] })).toBeTruthy();
});

it("M1: expires never-used clients after one hour, retains used clients, and removes their pending grants", async () => {
  const h = setup();
  const used = await registerClient(h.handler);
  await tokens(h.handler, used, h.passcode);
  const unused = await registerClient(h.handler);
  await consentForm(h.handler, authorizationUrl(unused));
  h.advance(3_599_999);
  await registerClient(h.handler);
  expect(new OAuthStore(h.directory).read().clients.some((c) => c.hash === hash(unused))).toBe(true);
  h.advance(1);
  await registerClient(h.handler);
  const data = new OAuthStore(h.directory).read();
  expect(data.clients.some((c) => c.hash === hash(unused))).toBe(false);
  expect(data.clients.some((c) => c.hash === hash(used))).toBe(true);
  expect(data.pending.some((p) => p.clientHash === hash(unused))).toBe(false);
});

it("M1: evicts the oldest never-used client first and refuses to evict any used client at capacity", async () => {
  const h = setup();
  const used = await registerClient(h.handler);
  await tokens(h.handler, used, h.passcode);
  const oldest = await registerClient(h.handler);
  h.advance(1);
  const recent = await registerClient(h.handler);
  for (let i = 3; i < 100; i++) await registerClient(h.handler);
  await registerClient(h.handler);
  const store = new OAuthStore(h.directory);
  expect(store.read().clients).toHaveLength(100);
  expect(store.read().clients.some((c) => c.hash === hash(oldest))).toBe(false);
  expect(store.read().clients.some((c) => c.hash === hash(used))).toBe(true);
  expect(store.read().clients.some((c) => c.hash === hash(recent))).toBe(true);
  await store.transaction((data) => { for (const client of data.clients) client.used = true; });
  expect((await registration(h, {})).status).toBe(429);
  expect(store.read().clients).toHaveLength(100);
});

it("M1: migrates legacy used clients from token evidence and prunes legacy unauthenticated registrations", async () => {
  const h = setup();
  const used = await registerClient(h.handler);
  await tokens(h.handler, used, h.passcode);
  const unused = await registerClient(h.handler);
  const file = join(h.directory, "store.json");
  const legacy = JSON.parse(readFileSync(file, "utf8")) as { clients: { createdAt?: number; used?: boolean }[] };
  for (const client of legacy.clients) { delete client.createdAt; delete client.used; }
  writeFileSync(file, JSON.stringify(legacy));
  await registerClient(h.handler);
  const data = new OAuthStore(h.directory).read();
  expect(data.clients.some((c) => c.hash === hash(used))).toBe(true);
  expect(data.clients.some((c) => c.hash === hash(unused))).toBe(false);
});

it("M2: renders HTML for formerly registered outside origins, including a pending deny POST", async () => {
  const h = setup();
  const client = await registerClient(h.handler);
  const consent = await consentForm(h.handler, authorizationUrl(client));
  expect(consent.html).toContain('<strong>Redirect origin: https://example.org</strong>');
  const restricted = createOAuth({ ...h.config, allowedRedirectOrigins: ["https://example.net"] }, h.options).wrap(async () => new Response());
  for (const extra of [{}, { response_type: "token" }] as Record<string, string>[]) {
    const error = await restricted(new Request(authorizationUrl(client, extra)));
    expect(error.status).toBe(400);
    expect(error.headers.get("content-type")).toContain("text/html");
    expect(error.headers.has("location")).toBe(false);
    expect(await error.text()).toContain("Authorization failed");
  }
  const denial = await restricted(request("/oauth/authorize", { transaction: consent.transaction, decision: "deny" }, { origin: ISSUER, cookie: consent.cookie }));
  expect(denial.status).toBe(400);
  expect(denial.headers.get("content-type")).toContain("text/html");
  expect(denial.headers.has("location")).toBe(false);
});

it("M3: the local CLI unlocks without resetting failures or revoking tokens and has no HTTP equivalent", async () => {
  const h = setup();
  const client = await registerClient(h.handler);
  const token = await tokens(h.handler, client, h.passcode);
  for (let i = 0; i < 5; i++) await approve(h.handler, authorizationUrl(client), "wrong");
  const store = new OAuthStore(h.directory);
  expect(store.read().lockouts.global.failures).toBe(5);
  const cli = spawnSync(process.execPath, ["bin/dots-stackchan.mjs", "unlock"], { env: { ...process.env, OAUTH_STORE_DIR: h.directory }, encoding: "utf8" });
  expect(cli.status).toBe(0);
  expect(cli.stdout).toContain("Failure counts retained");
  expect(store.read().lockouts.global).toEqual({ failures: 5, until: 0 });
  expect((await approve(h.handler, authorizationUrl(client), h.passcode)).status).toBe(303);
  expect(store.read().lockouts.global.failures).toBe(5);
  expect((await h.handler(request("/mcp", undefined, { authorization: `Bearer ${token.access_token}` }))).status).toBe(200);
  expect((await h.handler(request("/oauth/unlock", {}))).status).toBe(404);
  await unlockOAuth(h.directory);
});

it("L1: serializes asynchronous transactions across store instances and releases the mutex on failure", async () => {
  const h = setup();
  const a = new OAuthStore(h.directory, RESOURCE);
  const b = new OAuthStore(h.directory, RESOURCE);
  const order: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = a.transaction(async (data) => { order.push(1); await gate; data.lockouts.global = { failures: 1, until: 0 }; order.push(2); });
  const second = b.transaction((data) => { order.push(3); data.lockouts.global.failures++; });
  await vi.waitFor(() => expect(order).toEqual([1]));
  expect(JSON.parse(readFileSync(join(h.directory, "transaction.lock"), "utf8"))).toMatchObject({ pid: process.pid, startTime: expect.any(Number) });
  release();
  await Promise.all([first, second]);
  expect(order).toEqual([1, 2, 3]);
  expect(a.read().lockouts.global.failures).toBe(2);
  await expect(a.transaction((data) => { data.lockouts.global.failures = 100; throw new Error("abort"); })).rejects.toThrow("abort");
  await b.transaction((data) => { expect(data.lockouts.global.failures).toBe(2); });
  expect(existsSync(join(h.directory, "transaction.lock"))).toBe(false);
});

it("L1: recovers a dead writer's lock but waits for a live writer to release its lock", async () => {
  const h = setup();
  const store = new OAuthStore(h.directory, RESOURCE);
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  const lock = join(h.directory, "transaction.lock");
  writeFileSync(lock, JSON.stringify({ pid: Number(child.stdout), startTime: Date.now() }), { mode: 0o600 });
  await store.transaction((data) => { data.lockouts.global = { failures: 1, until: 0 }; });
  expect(existsSync(lock)).toBe(false);
  // A live OS writer outside the in-process mutex must never be stolen.
  const { unlinkSync } = await import("node:fs");
  writeFileSync(lock, JSON.stringify({ pid: process.pid, startTime: Date.now() }), { mode: 0o600 });
  let entered = false;
  const waiting = store.transaction(() => { entered = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(entered).toBe(false);
  unlinkSync(lock);
  await waiting;
  expect(entered).toBe(true);
});

it("L1: serializes independent OS writers while recovering the same stale lock", async () => {
  const h = setup();
  const store = new OAuthStore(h.directory, RESOURCE);
  await store.transaction((data) => { data.lockouts.global = { failures: 0, until: 0 }; });
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  writeFileSync(join(h.directory, "transaction.lock"), JSON.stringify({ pid: Number(dead.stdout), startTime: Date.now() }), { mode: 0o600 });
  const script = `import { OAuthStore } from "./dist/oauth/store.js";
    const store = new OAuthStore(process.env.OAUTH_STORE_DIR);
    for (let i = 0; i < 5; i++) await store.transaction(async (data) => {
      const previous = data.lockouts.global.failures;
      await new Promise((resolve) => setTimeout(resolve, 5));
      data.lockouts.global.failures = previous + 1;
    });`;
  await Promise.all(Array.from({ length: 4 }, () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, OAUTH_STORE_DIR: h.directory }, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("OS writer failed")));
  })));
  expect(store.read().lockouts.global.failures).toBe(20);
  expect(existsSync(join(h.directory, "transaction.lock"))).toBe(false);
});

it("L2: caches parsed reads for bogus bearer tokens, invalidates on external writes and protects cached state", async () => {
  const h = setup();
  const client = await registerClient(h.handler);
  await tokens(h.handler, client, h.passcode);
  const store = new OAuthStore(h.directory, RESOURCE);
  store.read();
  const parse = vi.spyOn(JSON, "parse");
  for (let i = 0; i < 10; i++) store.read();
  expect(parse).not.toHaveBeenCalled();
  const copy = store.read(); copy.clients = [];
  expect(store.read().clients).toHaveLength(1);
  await new OAuthStore(h.directory, RESOURCE).transaction((data) => { data.lockouts.global = { failures: 1, until: 0 }; });
  parse.mockClear();
  expect(store.read().lockouts.global.failures).toBe(1);
  expect(parse).toHaveBeenCalledTimes(1);
  // Verify the actual handler path also avoids parsing on repeatedly invalid, well-formed bearers.
  const bogus = randomBytes(32).toString("base64url");
  await h.handler(request("/mcp", undefined, { authorization: `Bearer ${bogus}` }));
  parse.mockClear();
  for (let i = 0; i < 10; i++) expect((await h.handler(request("/mcp", undefined, { authorization: `Bearer ${bogus}` }))).status).toBe(401);
  expect(parse).not.toHaveBeenCalled();
});

it("L3: returns the same rotated pair within ten seconds across restart and revokes at the grace boundary", async () => {
  const h = setup();
  const client = await registerClient(h.handler);
  const initial = await tokens(h.handler, client, h.passcode);
  const old = initial.refresh_token ?? "";
  const simultaneous = await Promise.all([h.handler(refreshRequest(client, old)), h.handler(refreshRequest(client, old))]);
  const [first, duplicate] = await Promise.all(simultaneous.map((r) => r.json() as Promise<TokenResponse>));
  expect(first).toEqual(duplicate);
  h.advance(9999);
  const restarted = createOAuth(h.config, h.options).wrap(async () => new Response());
  const retry = await (await restarted(refreshRequest(client, old))).json() as TokenResponse;
  expect(retry.access_token).toBe(first.access_token);
  expect(retry.refresh_token).toBe(first.refresh_token);
  expect(new OAuthStore(h.directory).read().access).toHaveLength(2);
  const raw = readFileSync(join(h.directory, "store.json"), "utf8");
  for (const secret of [old, first.access_token, first.refresh_token ?? ""]) expect(raw).not.toContain(secret);
  h.advance(1);
  expect((await restarted(refreshRequest(client, old))).status).toBe(400);
  expect((await h.handler(request("/mcp", undefined, { authorization: `Bearer ${first.access_token}` }))).status).toBe(401);
});

it("L3: allows grace only for the immediately previous token and retains client/resource binding", async () => {
  const h = setup();
  const client = await registerClient(h.handler);
  const other = await registerClient(h.handler);
  const initial = await tokens(h.handler, client, h.passcode);
  const next = await (await h.handler(refreshRequest(client, initial.refresh_token ?? ""))).json() as TokenResponse;
  expect((await h.handler(refreshRequest(other, initial.refresh_token ?? ""))).status).toBe(400);
  expect((await h.handler(refreshRequest(client, initial.refresh_token ?? "", { resource: "https://example.net/mcp" }))).status).toBe(400);
  expect((await h.handler(refreshRequest(client, next.refresh_token ?? ""))).status).toBe(200);
  expect((await h.handler(refreshRequest(client, initial.refresh_token ?? ""))).status).toBe(400);
  expect(new OAuthStore(h.directory).read().refresh).toHaveLength(0);
});

it("L4: accepts omitted resource for codes and refreshes but rejects present empty or mismatching values", async () => {
  const h = setup();
  const client = await registerClient(h.handler);
  const code = await authorize(h.handler, client, h.passcode);
  for (const resource of ["", "https://example.net/mcp"]) expect((await h.handler(codeRequest(client, code, { resource }))).status).toBe(400);
  async function omit(req: Request): Promise<Request> {
    const params = new URLSearchParams(await req.text()); params.delete("resource");
    return new Request(req.url, { method: "POST", headers: req.headers, body: params });
  }
  const issued = await h.handler(await omit(codeRequest(client, code)));
  expect(issued.status).toBe(200);
  const token = await issued.json() as TokenResponse;
  for (const resource of ["", "https://example.net/mcp"]) expect((await h.handler(refreshRequest(client, token.refresh_token ?? "", { resource }))).status).toBe(400);
  const refresh = await h.handler(await omit(refreshRequest(client, token.refresh_token ?? "")));
  expect(refresh.status).toBe(200);
  expect(new OAuthStore(h.directory).read().access.every((entry) => entry.resource === RESOURCE)).toBe(true);
});

it.each(["\u0000", "\n", "\u007f", "\u0085", "\u202e", "\u2066", "\u200f", "\u2028", "\u2029"])("L5: rejects invisible characters in displayed client names (%j)", async (char) => {
  const h = setup();
  expect((await registration(h, { client_name: `Client${char}` })).status).toBe(400);
  expect((await registration(h, { redirect_uris: [`https://example.org/${char}`] })).status).toBe(400);
  expect(() => validateOAuthConfig({ ...h.config, publicUrl: `https://example.com${char}:8443/mcp` })).toThrow();
});

it("L5: caps client names and rejects unsafe legacy displayed metadata at consent", async () => {
  const h = setup();
  expect((await registration(h, { client_name: "a".repeat(121) })).status).toBe(400);
  expect((await registration(h, { client_name: "a".repeat(120) })).status).toBe(201);
  const client = await registerClient(h.handler);
  await new OAuthStore(h.directory).transaction((data) => { const c = data.clients.find((c) => c.hash === hash(client)); if (c) c.name = "Legacy\u202e"; });
  expect((await h.handler(new Request(authorizationUrl(client)))).status).toBe(400);
});
