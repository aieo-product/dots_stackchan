import {
  auth, Client, StreamableHTTPClientTransport, type OAuthClientProvider, type OAuthDiscoveryState,
  type OAuthClientMetadata, type StoredOAuthClientInformation, type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { afterEach, expect, it } from "vitest";

import { createMcpServer, type McpHttpServer } from "../src/mcp/server.js";
import type { McpToolDependencies } from "../src/mcp/tools.js";
import { harness, ISSUER, REDIRECT, RESOURCE } from "./oauth-helpers.js";

class Provider implements OAuthClientProvider {
  readonly redirectUrl = REDIRECT;
  readonly clientMetadata: OAuthClientMetadata = {
    redirect_uris: [REDIRECT], client_name: "SDK integration client", token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
  };
  client?: StoredOAuthClientInformation;
  savedTokens?: StoredOAuthTokens;
  verifier = "";
  authorization?: URL;
  discovery?: OAuthDiscoveryState;
  state(): string { return "sdk-state"; }
  clientInformation(): StoredOAuthClientInformation | undefined { return this.client; }
  saveClientInformation(client: StoredOAuthClientInformation): void { this.client = client; }
  tokens(): StoredOAuthTokens | undefined { return this.savedTokens; }
  saveTokens(tokens: StoredOAuthTokens): void { this.savedTokens = tokens; }
  redirectToAuthorization(url: URL): void { this.authorization = url; }
  saveCodeVerifier(verifier: string): void { this.verifier = verifier; }
  codeVerifier(): string { return this.verifier; }
  saveDiscoveryState(state: OAuthDiscoveryState): void { this.discovery = state; }
  discoveryState(): OAuthDiscoveryState | undefined { return this.discovery; }
}

const fixtures: ReturnType<typeof harness>[] = [];
const servers: McpHttpServer[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.close();
  fixtures.splice(0).forEach((fixture) => fixture.cleanup());
});

const dependencies: McpToolDependencies = {
  device: { online: true, caps: { sanotts: true, servo: true, mic: true }, send() {}, sendBinary() {}, on() {} },
  speaker: { say: () => ({ id: "test-speech", estimatedSeconds: 1, done: Promise.resolve() }), cancelAll() {} },
  listener: { nextUtterance: () => Promise.resolve(null) },
};

it("uses the standard SDK OAuth flow through the real HTTP listener, calls a tool, and refreshes", async () => {
  const h = harness();
  fixtures.push(h);
  const server = createMcpServer(dependencies, { oauth: h.oauth });
  servers.push(server);
  const address = await server.listen(0);
  const local = `http://${address.host}:${address.port}`;
  // Route public HTTPS URLs to loopback in this test only; keep the real SDK discovery/resource checks.
  const localFetch: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.origin !== ISSUER) throw new Error("Unexpected outbound OAuth request.");
    return fetch(`${local}${url.pathname}${url.search}`, { ...init, redirect: "manual" });
  };
  const unauthorized = await localFetch(RESOURCE);
  expect(unauthorized.status).toBe(401);
  expect(unauthorized.headers.get("www-authenticate")).toContain("resource_metadata=");
  expect((await fetch(`${local}/device`)).status).toBe(404);
  expect((await fetch(`${local}/oauth/token`, { method: "POST", body: "x".repeat(65_537) })).status).toBe(413);

  const provider = new Provider();
  expect(await auth(provider, { serverUrl: RESOURCE, fetchFn: localFetch })).toBe("REDIRECT");
  expect(provider.authorization).toBeDefined();
  const authorization = provider.authorization;
  if (!authorization) throw new Error("SDK did not request authorization.");
  expect(authorization.searchParams.get("resource")).toBe(RESOURCE);
  const consent = await localFetch(authorization);
  expect(consent.status).toBe(200);
  const html = await consent.text();
  const transaction = /name="transaction" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1] ?? "";
  const callback = await localFetch(`${ISSUER}/oauth/authorize`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: ISSUER, cookie: consent.headers.get("set-cookie")?.split(";")[0] ?? "" },
    body: new URLSearchParams({ transaction, passcode: h.passcode, decision: "allow" }),
  });
  expect(callback.status).toBe(303);
  const location = new URL(callback.headers.get("location") ?? "");
  expect(location.searchParams.get("state")).toBe(await provider.state());
  expect(await auth(provider, { serverUrl: RESOURCE, authorizationCode: location.searchParams.get("code") ?? "", iss: location.searchParams.get("iss") ?? "", fetchFn: localFetch })).toBe("AUTHORIZED");
  expect(provider.savedTokens?.access_token).toBeDefined();
  const originalRefresh = provider.savedTokens?.refresh_token;

  const client = new Client({ name: "oauth-integration-test", version: "0.0.0" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(RESOURCE), { authProvider: provider, fetch: localFetch }));
  expect((await client.listTools()).tools).toHaveLength(6);
  const result = await client.callTool({ name: "get_status", arguments: {} });
  expect(result.isError).not.toBe(true);
  expect(result.content[0]).toMatchObject({ type: "text" });

  h.advance(3_600_000);
  expect(await auth(provider, { serverUrl: RESOURCE, fetchFn: localFetch })).toBe("AUTHORIZED");
  expect(provider.savedTokens?.refresh_token).not.toBe(originalRefresh);
  expect((await client.callTool({ name: "set_expression", arguments: { expression: "happy" } })).isError).not.toBe(true);
});
