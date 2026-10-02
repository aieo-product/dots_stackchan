import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Webhook } from "standardwebhooks";
import WebSocket from "ws";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startApp, type AppOptions } from "../src/app/app.js";
import { loadAppConfig } from "../src/app/config.js";
import { createDeviceAuth } from "../src/auth.js";
import { createLogger } from "../src/log.js";
import { BinaryKind, decodeBinaryFrame, encodeBinaryFrame } from "../src/protocol.js";
import { FakeStt } from "../src/stt/engine.js";
import { OAuthStore, revokeFamily } from "../src/oauth/store.js";
import { hash } from "../src/oauth/crypto.js";
import type { SlackClient, SlackMessage } from "../src/slack/client.js";
import type { SpeechTicket } from "../src/tts/speaker.js";
import { listenFake, startFakeLocalTts } from "./fixtures/fake-local-tts.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
  finally { vi.restoreAllMocks(); }
});

async function setup(env: NodeJS.ProcessEnv = {}, options: Partial<AppOptions> = {}) {
  const directory = mkdtempSync(join(process.cwd(), ".events.local.test-app-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const psk = randomBytes(24).toString("hex");
  const lines: string[] = [];
  const kana = { convert: vi.fn(async () => "こ[んにちうぁ"), dispose: vi.fn() };
  const config = loadAppConfig({ DEVICE_PSK: psk, BRIDGE_HOST: "localhost", STT_ENGINE: "fake", VOICE_MODE: "device",
    QUIET_HOURS: "", EVENTS_ENABLED: "false", EVENTS_STORE_DIR: directory, ...env });
  const app = await startApp({ config, logger: createLogger("debug", line => lines.push(line)), kana,
    ports: { device: 0, localMcp: 0, publicMcp: 0 }, ...options });
  cleanups.push(() => app.close());
  const client = new Client({ name: "integration-test", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://${app.addresses.localMcp.host}:${app.addresses.localMcp.port}/mcp`)));
  cleanups.push(() => client.close());
  const connect = async (deviceId = "integration-device", sanotts = true, timestamp = String(Math.floor(Date.now() / 1000))) => {
    const socket = new WebSocket(`ws://localhost:${app.addresses.device.port}/device`, { headers: {
      "X-Device-Id": deviceId, "X-Timestamp": timestamp, "X-Auth": createDeviceAuth(psk, deviceId, timestamp),
    } });
    const messages: Record<string, unknown>[] = [];
    const binary: Uint8Array[] = [];
    socket.on("message", (bytes, isBinary) => {
      if (isBinary) binary.push(new Uint8Array(Buffer.from(bytes as Buffer)));
      else messages.push(JSON.parse(bytes.toString()) as Record<string, unknown>);
    });
    await once(socket, "open");
    cleanups.push(() => socket.terminate());
    const send = (message: Record<string, unknown>) => socket.send(JSON.stringify(message));
    send({ type: "hello", fw: "test", caps: { sanotts, servo: true, mic: true } });
    await vi.waitFor(() => expect(messages.some(message => message.type === "welcome")).toBe(true));
    return { socket, messages, binary, send };
  };
  return { app, client, connect, kana, lines };
}

async function subscribe(client: Client, name: string, secret: string, url = "https://receiver.example.com/callback") {
  return client.request({ method: "events/subscribe", params: {
    name, arguments: {}, delivery: { mode: "webhook", url, secret }, ttlMs: 60_000,
  } }, z.record(z.string(), z.unknown()));
}

async function signedReceiver() {
  const secret = `whsec_${randomBytes(32).toString("base64")}`;
  const received: Record<string, unknown>[] = [];
  const signatures: boolean[] = [];
  const server = await listenFake((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      const headers = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name, String(value)]));
      const payload = new Webhook(secret).verify(body, headers) as Record<string, unknown>;
      signatures.push(true);
      if (payload.type === "verification") response.end(JSON.stringify({ challenge: payload.challenge }));
      else { received.push(payload); response.end("{}"); }
    })().catch(() => response.writeHead(400).end());
  });
  cleanups.push(() => server.close());
  // Inject the delivery boundary, mapping ONLY this synthetic HTTPS callback to loopback.
  // Production retains DNS validation, pinning, TLS and redirect rejection.
  const post: NonNullable<AppOptions["eventPost"]> = async (destination, body, headers) => {
    expect(destination).toBe("https://receiver.example.com/callback");
    const response = await fetch(`${server.url}/callback`, { method: "POST", body, headers, redirect: "error" });
    return { status: response.status, body: await response.text() };
  };
  return { secret, received, signatures, post };
}

describe("integrated bridge on real ephemeral listeners", () => {
  it("MCP say converts kana and resolves its ticket only after device tts.done", async () => {
    const { app, client, connect, kana, lines } = await setup();
    const device = await connect();
    const say = vi.spyOn(app.speaker, "say");
    const result = client.callTool({ name: "say", arguments: { text: "こんにちは。", expression: "happy", wait: true } });
    await vi.waitFor(() => expect(device.messages.find(message => message.type === "speak.kana")).toBeDefined());
    const speech = device.messages.find(message => message.type === "speak.kana");
    expect(speech).toEqual({ type: "speak.kana", seq: 1, kana: "こ[んにちうぁ", expression: "happy" });
    expect(device.messages).toContainEqual({ type: "voice.mode", mode: "device" });
    expect(kana.convert).toHaveBeenCalledWith("こんにちは。", expect.any(AbortSignal));
    const ticket = say.mock.results[0].value as SpeechTicket;
    const finished = vi.fn(); void ticket.done.then(finished);
    expect(finished).not.toHaveBeenCalled();
    device.send({ type: "tts.done", seq: speech?.seq, ok: true });
    expect(await result).toMatchObject({ content: [{ type: "text", text: "Stack-chan spoke the text." }] });
    expect(finished).toHaveBeenCalledOnce();
    expect(lines.join("\n")).not.toContain("こんにちは");
  });

  it.each([true, false])("bridge PCM is v1 framed and needs no sanoTTS (caps=%s)", async sanotts => {
    const engine = await startFakeLocalTts(); cleanups.push(() => engine.close());
    const { client, connect, kana } = await setup({ VOICE_MODE: "bridge", TTS_ENGINE: "local-http", LOCAL_TTS_URL: `${engine.url}/tts` });
    const device = await connect("integration-device", sanotts);
    const result = client.callTool({ name: "say", arguments: { text: "こんにちは。", expression: "happy", wait: true } });
    await vi.waitFor(() => expect(device.messages.some(message => message.type === "tts.end")).toBe(true));
    expect(device.messages).toContainEqual({ type: "voice.mode", mode: "bridge" });
    expect(device.messages).toContainEqual({ type: "face", expression: "happy" });
    expect(device.messages).toContainEqual({ type: "tts.start", seq: 1, sample_rate: 16000, channels: 1, bits: 16 });
    const frames = device.binary.map(decodeBinaryFrame);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every(frame => frame.kind === 0x02 && frame.seq === 1 && frame.data.length % 2 === 0)).toBe(true);
    expect(device.binary.every(frame => frame.length <= 4096)).toBe(true);
    expect(frames.reduce((size, frame) => size + frame.data.length, 0)).toBe(3200);
    expect(kana.convert).not.toHaveBeenCalled();
    expect(engine.requests[0].body.text).toBe("こんにちは。");
    device.send({ type: "tts.done", seq: 1, ok: true });
    expect((await result).isError).not.toBe(true);
  });

  it("device mode honors sanotts:false with local PCM fallback", async () => {
    const engine = await startFakeLocalTts(); cleanups.push(() => engine.close());
    const { app, connect, kana } = await setup({ TTS_ENGINE: "local-http", LOCAL_TTS_URL: `${engine.url}/tts` });
    const device = await connect("integration-device", false);
    const ticket = app.speaker.say("こんにちは。");
    await vi.waitFor(() => expect(device.messages.some(message => message.type === "tts.end")).toBe(true));
    expect(device.messages.some(message => message.type === "speak.kana")).toBe(false);
    expect(kana.convert).not.toHaveBeenCalled();
    device.send({ type: "tts.done", seq: 1, ok: true }); await ticket.done;
  });

  it("notify chimes once, deduplicates, and tags STT -> signed Events and listen with reply_to", async () => {
    const receiver = await signedReceiver();
    const { app, client, connect, lines } = await setup({ EVENTS_ENABLED: "true", EVENTS_SECRET_KEY: randomBytes(32).toString("base64") }, { eventPost: receiver.post });
    await subscribe(client, "stackchan.utterance", receiver.secret);
    await subscribe(client, "stackchan.touched", receiver.secret);
    await subscribe(client, "stackchan.online_changed", receiver.secret);
    const device = await connect();
    const notification = { message: "こんにちは、通知です。", priority: "high", topic_id: "test-topic" };
    await client.callTool({ name: "notify", arguments: notification });
    await client.callTool({ name: "notify", arguments: notification });
    await vi.waitFor(() => expect(device.messages.filter(message => message.type === "speak.kana")).toHaveLength(1));
    const kinds = device.messages.map(message => message.type);
    expect(kinds.indexOf("chime")).toBeLessThan(kinds.indexOf("speak.kana"));
    expect(device.messages.filter(message => message.type === "chime")).toHaveLength(1);
    expect(app.notifications.pendingCount).toBe(0);
    device.send({ type: "tts.done", seq: 1, ok: true });
    await vi.waitFor(() => expect(app.notifications.context.forUtterance()).toEqual({ reply_to: "test-topic" }));
    const listen = client.callTool({ name: "listen", arguments: { timeout_s: 2 } });
    await vi.waitFor(() => expect(app.utterances.listenerCount("utterance")).toBe(2));
    device.send({ type: "mic.start", seq: 9, sample_rate: 16000 });
    device.socket.send(encodeBinaryFrame(BinaryKind.microphonePcm, 9, new Uint8Array(640)));
    device.send({ type: "mic.end", seq: 9, reason: "release" });
    expect(await listen).toMatchObject({ content: [{ text: JSON.stringify({ timed_out: false, text: "こんにちは、スタックちゃん" }) }] });
    device.send({ type: "event", kind: "touch", where: "screen" });
    await vi.waitFor(() => expect(receiver.received.map(event => event.name)).toEqual([
      "stackchan.online_changed", "stackchan.utterance", "stackchan.touched",
    ]));
    expect(receiver.received[1]).toMatchObject({ name: "stackchan.utterance", data: {
      text: "こんにちは、スタックちゃん", lang: "ja", duration_ms: 20, reply_to: "test-topic",
    }, eventId: expect.any(String), timestamp: expect.any(String), cursor: null });
    expect(receiver.signatures).toHaveLength(4); // one verification, three deliveries
    const closed = once(device.socket, "close"); device.socket.close(); await closed;
    await vi.waitFor(() => expect(receiver.received[3]).toMatchObject({ name: "stackchan.online_changed", data: { online: false } }));
    expect(lines.join("\n")).not.toContain("こんにちは");
    expect(lines.join("\n")).not.toContain(receiver.secret);
  });

  it("PTT rejects interrupted tickets, accepts capture, and shutdown resolves waiting listeners", async () => {
    const { app, connect, kana } = await setup(); const device = await connect();
    const ticket = app.speaker.say("こんにちは。");
    await vi.waitFor(() => expect(device.messages.some(message => message.type === "speak.kana")).toBe(true));
    device.send({ type: "state", state: "speaking" });
    const heard = app.utterances.nextUtterance(2000);
    device.send({ type: "mic.start", seq: 3, sample_rate: 16000 });
    device.socket.send(encodeBinaryFrame(BinaryKind.microphonePcm, 3, new Uint8Array(640)));
    device.send({ type: "mic.end", seq: 3, reason: "release" });
    await expect(ticket.done).rejects.toThrow();
    expect(await heard).toMatchObject({ text: "こんにちは、スタックちゃん" });
    const waiting = app.utterances.nextUtterance(120000);
    await app.close(); expect(await waiting).toBeNull();
    expect(kana.dispose).toHaveBeenCalledOnce();
    await app.close(); expect(kana.dispose).toHaveBeenCalledOnce();
  });
});

it("public OAuth listener denies anonymous calls and stops Events after grant revocation", async () => {
  const directory = mkdtempSync(join(process.cwd(), ".oauth.local.test-app-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const resource = "https://bridge.example.com/mcp";
  const store = new OAuthStore(directory, resource);
  const token = randomBytes(32).toString("base64url");
  const family = hash("test-family");
  const clientHash = hash("test-client");
  await store.transaction(data => {
    data.clients.push({ hash: clientHash, name: "test-client", redirectUris: ["https://chatgpt.com/callback"], refresh: false, createdAt: Date.now(), used: true });
    data.access.push({ hash: hash(token), clientHash, family, resource, expires: Date.now() + 60000, used: false });
  });
  const receiver = await signedReceiver();
  const { app, connect } = await setup({ MCP_PUBLIC_URL: resource, MCP_PASSCODE: randomBytes(24).toString("hex"),
    OAUTH_STORE_DIR: directory, EVENTS_ENABLED: "true", EVENTS_SECRET_KEY: randomBytes(32).toString("base64") }, { eventPost: receiver.post });
  const address = app.addresses.publicMcp;
  expect(address).toBeDefined();
  const base = `http://${address?.host}:${address?.port}`;
  expect((await fetch(`${base}/mcp`)).status).toBe(401);
  expect((await fetch(`${base}/device`)).status).toBe(404);
  expect((await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).status).toBe(200);
  const publicClient = new Client({ name: "public-integration-test", version: "0.0.0" }, { versionNegotiation: { mode: "auto" } });
  cleanups.push(() => publicClient.close());
  await publicClient.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  await subscribe(publicClient, "stackchan.touched", receiver.secret);
  const device = await connect();
  device.send({ type: "event", kind: "touch" });
  await vi.waitFor(() => expect(receiver.received).toHaveLength(1));
  await store.transaction(data => revokeFamily(data, family));
  const published = await app.events.dispatcher?.publish({ name: "stackchan.touched", data: { where: "screen" } });
  expect(published).toBeUndefined();
  expect(receiver.received).toHaveLength(1);
  expect((await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
  expect((await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${randomBytes(32).toString("base64url")}` } })).status).toBe(401);
});

it("cleans every started component if the MCP port is occupied", async () => {
  const occupied = createServer((_request, response) => response.end());
  await new Promise<void>(resolve => occupied.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>(resolve => occupied.close(() => resolve())));
  const kana = { convert: vi.fn(async () => "あ"), dispose: vi.fn() };
  const lines: string[] = [];
  const config = loadAppConfig({ DEVICE_PSK: "test-only", STT_ENGINE: "fake", EVENTS_ENABLED: "false", BRIDGE_HOST: "localhost" });
  await expect(startApp({ config, kana, ports: { device: 0, localMcp: (occupied.address() as AddressInfo).port },
    logger: createLogger("debug", line => lines.push(line)) }).then(app => { cleanups.push(() => app.close()); return app; })).rejects.toMatchObject({ code: "EADDRINUSE" });
  expect(kana.dispose).toHaveBeenCalledOnce();
  const started = lines.map(line => JSON.parse(line) as { event: string; port: number }).find(line => line.event === "bridge_started");
  await expect(fetch(`http://localhost:${started?.port}/healthz`)).rejects.toThrow();
  expect(lines.join("\n")).not.toContain("startup_cleanup_failed");
});

it("Slack mirror receives STT once and shares notification deduplication with MCP", async () => {
  let receive: ((message: SlackMessage) => void) | undefined;
  const slack: SlackClient = {
    session: { channel: "DTESTDM", ownUserId: "USELFTEST", dotUserId: "UDOTTEST" }, status: "online",
    start: vi.fn(async () => {}), stop: vi.fn(async () => {}), post: vi.fn(async () => {}),
    onMessage: callback => { receive = callback; return () => { receive = undefined; }; },
    onStatus: () => () => {},
  };
  const { app, client, connect } = await setup({ SLACK_ENABLED: "true", ROUTE: "both",
    SLACK_APP_TOKEN: ["xapp", "synthetic"].join("-"), SLACK_USER_TOKEN: ["xoxp", "synthetic"].join("-"), SLACK_DOT_USER_ID: "UDOTTEST" }, { slackClient: slack });
  const device = await connect();
  device.send({ type: "mic.start", seq: 1, sample_rate: 16000 });
  device.socket.send(encodeBinaryFrame(BinaryKind.microphonePcm, 1, new Uint8Array(640)));
  device.send({ type: "mic.end", seq: 1, reason: "release" });
  await vi.waitFor(() => expect(slack.post).toHaveBeenCalledExactlyOnceWith("こんにちは、スタックちゃん"));
  receive?.({ type: "message", channel: "DTESTDM", user: "UDOTTEST", ts: "1.001", text: "こんにちは、通知です。" });
  expect(app.notifications.pendingCount).toBe(1);
  await client.callTool({ name: "notify", arguments: { message: "こんにちは、通知です。", priority: "high" } });
  expect(app.notifications.pendingCount).toBe(1);
  await vi.waitFor(() => expect(device.messages.filter(message => message.type === "chime")).toHaveLength(1), { timeout: 3000 });
  await vi.waitFor(() => expect(device.messages.some(message => message.type === "speak.kana")).toBe(true));
  device.send({ type: "tts.done", seq: 1, ok: true });
  await app.close();
  expect(slack.stop).toHaveBeenCalledOnce(); expect(receive).toBeUndefined();
});

it("replacement cancels old speech/listen and builds a fresh per-connection queue", async () => {
  const { app, connect } = await setup();
  const first = await connect();
  const old = app.speaker.say("こんにちは。");
  await vi.waitFor(() => expect(first.messages.some(message => message.type === "speak.kana")).toBe(true));
  const waiting = app.utterances.nextUtterance(120000);
  const replacement = await connect("integration-device", true, String(Math.floor(Date.now() / 1000) + 1));
  await expect(old.done).rejects.toThrow();
  expect(await waiting).toBeNull();
  const current = app.speaker.say("こんにちは。");
  await vi.waitFor(() => expect(replacement.messages.some(message => message.type === "speak.kana")).toBe(true));
  expect(replacement.messages.find(message => message.type === "speak.kana")?.seq).toBe(1);
  replacement.send({ type: "tts.done", seq: 1, ok: true });
  await current.done;
});

it("notification reply context uses accepted capture time despite slow transcription", async () => {
  let release: (() => void) | undefined;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  const engine = new FakeStt();
  const end = engine.end.bind(engine);
  const ending = vi.spyOn(engine, "end").mockImplementation(async () => { await delayed; return end(); });
  const { app, connect } = await setup({}, { createSttEngine: () => engine });
  const device = await connect();
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  app.notifications.context.recordPlayback("slow-test-topic", now);
  now += 1000;
  const heard = app.utterances.nextUtterance(2000);
  device.send({ type: "mic.start", seq: 1, sample_rate: 16000 });
  device.socket.send(encodeBinaryFrame(BinaryKind.microphonePcm, 1, new Uint8Array(640)));
  device.send({ type: "mic.end", seq: 1, reason: "release" });
  await vi.waitFor(() => expect(ending).toHaveBeenCalledOnce());
  now += 12000;
  expect(app.notifications.context.forUtterance(now)).toBeUndefined();
  release?.();
  expect(await heard).toMatchObject({ text: "こんにちは、スタックちゃん", reply_to: "slow-test-topic" });
});

it("shutdown aborts an in-flight MCP say before waiting for HTTP teardown", async () => {
  const { app, client, connect } = await setup();
  const device = await connect();
  const waiting = client.callTool({ name: "say", arguments: { text: "こんにちは。", wait: true } });
  await vi.waitFor(() => expect(device.messages.some(message => message.type === "speak.kana")).toBe(true));
  await app.close();
  expect((await waiting).isError).toBe(true);
  expect(await app.utterances.nextUtterance(120000)).toBeNull();
});
