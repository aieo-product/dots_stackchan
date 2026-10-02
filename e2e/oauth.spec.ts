import { expect, test } from "@playwright/test";

import { createMcpServer } from "../bridge/src/mcp/server.js";
import { authorizationUrl, harness, ISSUER, REDIRECT, RESOURCE, VERIFIER } from "../bridge/test/oauth-helpers.js";

test("Chromium consent form keeps its real Origin and completes code → token → MCP", async ({ page }) => {
  const h = harness();
  const server = createMcpServer({
    device: { online: true, caps: { sanotts: true, servo: true, mic: true }, send() {}, sendBinary() {}, on() {} },
    speaker: { say: () => ({ id: "browser-test", estimatedSeconds: 1, done: Promise.resolve() }), cancelAll() {} },
    listener: { nextUtterance: () => Promise.resolve(null) },
  }, { oauth: h.oauth });
  try {
    const address = await server.listen(0, "127.0.0.1");
    const local = `http://127.0.0.1:${address.port}`;
    const registered = await fetch(`${local}/oauth/register`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Browser test" }),
    });
    expect(registered.status).toBe(201);
    const { client_id: client } = await registered.json() as { client_id: string };
    let postOrigin: string | undefined;
    // Map the test HTTPS public URL to the real loopback server without changing the browser's
    // security origin, cookie flags, Referrer-Policy, form navigation or automatically generated Origin.
    await page.route(`${ISSUER}/**`, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const headers = await request.allHeaders();
      if (request.method() === "POST") postOrigin = headers.origin;
      const response = await fetch(`${local}${url.pathname}${url.search}`, {
        method: request.method(), headers, body: request.postData() ?? undefined, redirect: "manual",
      });
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
    });
    await page.route("https://example.org/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<h1>Test callback</h1>" }));
    const consent = await page.goto(authorizationUrl(client));
    expect(consent?.headers()["referrer-policy"]).toBe("same-origin");
    await expect(page.getByText("Redirect origin: https://example.org", { exact: true })).toBeVisible();
    await page.getByLabel("Passcode").fill(h.passcode);
    await page.getByRole("button", { name: "Allow", exact: true }).click();
    await page.waitForURL("https://example.org/**");
    expect(postOrigin).toBe(ISSUER);
    const callback = new URL(page.url());
    expect(callback.searchParams.get("state")).toBe("test-state");
    expect(callback.searchParams.get("iss")).toBe(ISSUER);
    const response = await fetch(`${local}/oauth/token`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: client,
        code: callback.searchParams.get("code") ?? "", code_verifier: VERIFIER, redirect_uri: REDIRECT }),
    });
    expect(response.status).toBe(200);
    const token = await response.json() as { access_token: string };
    // A valid token reaches MCP's method checks; absent/invalid tokens remain 401.
    expect((await fetch(`${local}/mcp`, { headers: { authorization: `Bearer ${token.access_token}` } })).status).not.toBe(401);
    expect((await fetch(`${local}/mcp`)).status).toBe(401);
    expect(RESOURCE).toBe(`${ISSUER}/mcp`);
  } finally { await server.close(); h.cleanup(); }
});
