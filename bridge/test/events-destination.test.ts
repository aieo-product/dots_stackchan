import { EventEmitter } from "node:events";
import { request } from "node:https";
import ipaddr from "ipaddr.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createWebhookPost, isPublicAddress, validateDestination, type Resolver } from "../src/events/destination.js";
import { callbackUrl, fixture, subscribeRequest } from "./events-support.js";

vi.mock("node:https", () => ({ request: vi.fn() }));
afterEach(() => vi.resetAllMocks());
const publicAddress = new ipaddr.IPv4([192, 0, 3, 1]).toString();
const publicResolver: Resolver = async () => [{ address: publicAddress, family: 4 }];

describe("callback address validation", () => {
  it("accepts HTTPS public unicast and rejects URL credentials, fragments and non-HTTPS", async () => {
    const destination = await validateDestination(callbackUrl, publicResolver);
    expect(destination.url.href).toBe(callbackUrl);
    const credentialUrl = new URL(callbackUrl);
    credentialUrl.username = "user";
    credentialUrl.password = "pass";
    for (const url of ["not a URL", "http://receiver.example.com/", credentialUrl.href, callbackUrl + "#fragment"]) {
      await expect(validateDestination(url, publicResolver)).rejects.toMatchObject({ reason: "invalid_url" });
    }
  });

  it.each([
    [10, 0, 0, 1], [172, 16, 0, 1], [192, 168, 0, 1], [127, 0, 0, 1],
    [169, 254, 0, 1], [100, 64, 0, 1], [0, 0, 0, 0], [224, 0, 0, 1],
    [240, 0, 0, 1], [198, 18, 0, 1], [192, 0, 2, 1],
  ])("blocks special IPv4 ranges (%s %s %s %s)", async (...octets) => {
    const address = new ipaddr.IPv4(octets).toString();
    expect(isPublicAddress(address)).toBe(false);
    await expect(validateDestination(callbackUrl, async () => [{ address, family: 4 }])).rejects.toMatchObject({ reason: "non_public_address" });
  });

  it("blocks IPv6 local, mapped, transition, documentation and unallocated addresses", async () => {
    for (const parts of [
      [0, 0, 0, 0, 0, 0, 0, 1], [0xfc00, 0, 0, 0, 0, 0, 0, 1], [0xfe80, 0, 0, 0, 0, 0, 0, 1],
      [0, 0, 0, 0, 0, 0xffff, 0x7f00, 1], [0x2002, 0, 0, 0, 0, 0, 0, 1],
      [0x2001, 0xdb8, 0, 0, 0, 0, 0, 1], [0x4000, 0, 0, 0, 0, 0, 0, 1],
    ]) {
      const address = new ipaddr.IPv6(parts).toString();
      expect(isPublicAddress(address)).toBe(false);
      await expect(validateDestination(`https://[${address}]/`)).rejects.toMatchObject({ reason: "non_public_address" });
    }
    expect(isPublicAddress(new ipaddr.IPv6([0x2600, 0, 0, 0, 0, 0, 0, 1]).toString())).toBe(true);
  });

  it("rejects localhost, numeric loopback URL forms, mixed DNS answers and empty DNS answers", async () => {
    const local = new ipaddr.IPv4([127, 0, 0, 1]).toString();
    await expect(validateDestination("https://localhost/", async () => [{ address: local, family: 4 }])).rejects.toMatchObject({ reason: "non_public_address" });
    await expect(validateDestination(`https://${String(0x7f000001)}/`)).rejects.toMatchObject({ reason: "non_public_address" });
    await expect(validateDestination(callbackUrl, async () => [
      { address: publicAddress, family: 4 }, { address: local, family: 4 },
    ])).rejects.toMatchObject({ reason: "non_public_address" });
    await expect(validateDestination(callbackUrl, async () => [])).rejects.toMatchObject({ reason: "non_public_address" });
    await expect(validateDestination(callbackUrl, async () => { throw new Error("DNS failure"); })).rejects.toMatchObject({ reason: "dns_failed" });
  });
});

describe("HTTPS delivery transport", () => {
  function mockRequest(status = 200) {
    const response = Object.assign(new EventEmitter(), { statusCode: status, destroy: vi.fn() });
    const req = Object.assign(new EventEmitter(), { end: vi.fn(() => {
      const callback = vi.mocked(request).mock.calls[0][2];
      if (typeof callback === "function") callback(response as never);
      response.emit("data", Buffer.from("{}"));
      response.emit("end");
    }) });
    vi.mocked(request).mockReturnValue(req as never);
    return { response, req };
  }

  it("pins the validated IP while preserving the original URL for TLS and Host", async () => {
    const { req } = mockRequest();
    const post = createWebhookPost(publicResolver);
    await expect(post(callbackUrl, "{}", { "Content-Type": "application/json" })).resolves.toEqual({ status: 200, body: "{}" });
    const options = vi.mocked(request).mock.calls[0][1];
    expect(options).toMatchObject({ method: "POST", agent: false, autoSelectFamily: false });
    expect(vi.mocked(request).mock.calls[0][0]).toEqual(new URL(callbackUrl));
    if (typeof options === "object" && "lookup" in options && options.lookup) {
      const callback = vi.fn();
      options.lookup("receiver.example.com", {}, callback);
      expect(callback).toHaveBeenCalledWith(null, publicAddress, 4);
    } else throw new Error("Missing pinned lookup.");
    expect(req.end).toHaveBeenCalledWith("{}");
  });

  it("resolves again on each connection and rejects rebinding before any POST", async () => {
    mockRequest();
    let calls = 0;
    const post = createWebhookPost(async () => [{ address: calls++ === 0 ? publicAddress : new ipaddr.IPv4([127, 0, 0, 1]).toString(), family: 4 }]);
    await post(callbackUrl, "{}", {});
    await expect(post(callbackUrl, "{}", {})).rejects.toMatchObject({ reason: "non_public_address" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects redirects without requesting their target", async () => {
    const { response } = mockRequest(302);
    await expect(createWebhookPost(publicResolver)(callbackUrl, "{}", {})).rejects.toMatchObject({ reason: "redirect" });
    expect(response.destroy).toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects private callbacks at subscription time using the production transport", async () => {
    const test = fixture({ post: createWebhookPost(async () => [{
      address: new ipaddr.IPv4([127, 0, 0, 1]).toString(), family: 4,
    }]) });
    try {
      await expect(test.dispatcher.subscribe("owner", subscribeRequest())).rejects.toMatchObject({ code: -32015, data: { reason: "non_public_address" } });
      expect(test.store.subscriptions()).toEqual([]);
      expect(request).not.toHaveBeenCalled();
    } finally { await test.cleanup(); }
  });

  it("rejects redirecting callbacks at subscription time using the production transport", async () => {
    mockRequest(307);
    const test = fixture({ post: createWebhookPost(publicResolver) });
    try {
      await expect(test.dispatcher.subscribe("owner", subscribeRequest())).rejects.toMatchObject({ code: -32015, data: { reason: "redirect" } });
      expect(test.store.subscriptions()).toEqual([]);
      expect(request).toHaveBeenCalledTimes(1);
    } finally { await test.cleanup(); }
  });
});
