import { Fillers } from "../fillers/controller.js";
import { loadAppConfig, type AppConfig } from "./config.js";
import { AppDevice } from "./device.js";
import { AppUtterances } from "./utterances.js";
import { appEventSource } from "./events.js";
import { createBridgeServer, type ListeningAddress } from "../server.js";
import { createLogger, type Logger } from "../log.js";
import { createSttEngineFactory } from "../stt/factory.js";
import type { SttEngine } from "../stt/engine.js";
import { createKanaConverter } from "../tts/create-kana.js";
import { createTtsRouter } from "../tts/create-router.js";
import { SpeechQueue } from "../tts/speech-queue.js";
import type { KanaConverter } from "../tts/types.js";
import type { Speaker } from "../tts/speaker.js";
import { createNotificationCenter } from "../notify/center.js";
import { createEvents } from "../events/index.js";
import type { WebhookPost } from "../events/destination.js";
import { createOAuth } from "../oauth/index.js";
import { createMcpServer, type McpHttpServer } from "../mcp/server.js";
import { SocketSlackClient, type SlackClient } from "../slack/client.js";
import { SlackMirror } from "../slack/mirror.js";

export interface AppOptions {
  config?: AppConfig;
  logger?: Logger;
  /** Injectable providers and ephemeral ports for hermetic integration tests. */
  createSttEngine?: () => SttEngine;
  kana?: KanaConverter & { dispose(): void };
  eventPost?: WebhookPost;
  slackClient?: SlackClient;
  ports?: { device?: number; localMcp?: number; publicMcp?: number };
}

/** Own all lifetimes in one place, including cleanup after partial startup failure. */
export async function startApp(options: AppOptions = {}) {
  const config = options.config ?? loadAppConfig();
  const logger = options.logger ?? createLogger(config.bridge.logLevel);
  const cleanups: Array<() => void | Promise<void>> = [];
  const stopWork: Array<() => void> = [];
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    const errors: unknown[] = [];
    // Settle in-flight tool requests before waiting for HTTP servers to close.
    for (const stop of stopWork.reverse()) {
      try { stop(); } catch (error) { errors.push(error); }
    }
    for (const cleanup of cleanups.reverse()) {
      try { await cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new Error("Application shutdown failed");
  })();
  try {
    const createEngine = options.createSttEngine ?? createSttEngineFactory(config.bridge, logger);
    const kana = options.kana ?? ((config.tts.VOICE_MODE === "device" || config.fillers.length > 0) ? await createKanaConverter(config.tts)
      : { convert: async () => { throw new Error("Kana conversion is unavailable in bridge mode"); }, dispose() {} });
    cleanups.push(() => kana.dispose());
    const bridge = createBridgeServer({ host: config.bridge.host, port: options.ports?.device ?? config.bridge.port,
      psk: config.bridge.devicePsk, logger,
      stt: { createEngine, logTranscripts: config.bridge.logTranscripts, allowBargeIn: true } });
    cleanups.push(() => bridge.close());
    const device = new AppDevice(bridge.hub);
    cleanups.push(() => device.dispose());
    const router = createTtsRouter(config.tts, kana, { openaiApiKey: config.bridge.openaiApiKey, localTtsToken: config.localTtsToken });
    const fillers = new Fillers(device, config.fillers, kana, router, () => logger.warn("fillers_setup_failed"));
    cleanups.push(() => fillers.dispose());
    stopWork.push(() => fillers.dispose());
    let queue: SpeechQueue | undefined;
    let speechActive = false;
    const stopSpeech = () => { const current = queue; queue = undefined; current?.dispose(); speechActive = false; };
    stopWork.push(stopSpeech);
    const speaker: Speaker = {
      say(text, opts) {
        if (!queue) throw new Error("Device is offline");
        fillers.cancel();
        return queue.say(text, opts);
      },
      cancelAll() { fillers.cancel(); queue?.cancelAll(); },
    };
    device.on("connected", () => {
      queue?.dispose();
      const current = new SpeechQueue(device, router, { maxChars: config.tts.TTS_MAX_CHARS,
        log: (event, fields) => logger.info(event, fields) });
      queue = current;
      current.on("speaking", (active: boolean) => {
        if (queue !== current) return;
        speechActive = active;
        if (active) for (const entry of bridge.hub.listDevices()) {
          if (device.isSelected(entry.deviceId)) bridge.hub.emit("stt.pause", { deviceId: entry.deviceId, payload: {} });
        }
        // Wake notification scheduling even when the firmware sends no state transition.
        device.emit("message", { type: "state", state: active ? "speaking" : device.state ?? "idle" });
      });
      router.announceMode(device);
      void fillers.connect();
    });
    device.on("offline", stopSpeech);
    const bargeIn = ({ deviceId }: { deviceId: string }) => { if (device.isSelected(deviceId)) speaker.cancelAll(); };
    bridge.hub.prependListener("mic.start", bargeIn);
    cleanups.push(() => { bridge.hub.off("mic.start", bargeIn); stopSpeech(); });
    const notifications = createNotificationCenter({ device, speaker, config: config.notify, isSpeaking: () => speechActive,
      log: entry => logger.info(`notification_${entry.event}`, { ...entry }) });
    cleanups.push(() => notifications.dispose());
    stopWork.push(() => notifications.dispose());
    const utterances = new AppUtterances(bridge.hub, device, notifications.context);
    cleanups.push(() => utterances.dispose());
    stopWork.push(() => utterances.dispose());
    const oauth = config.oauth ? createOAuth(config.oauth, { log: entry => logger.info("oauth_access", { ...entry }) }) : undefined;
    const localPrincipal = "local:operator";
    const events = createEvents({
      authorizePrincipal: async context => context.http?.authInfo?.clientId ?? null,
      recheckAccess: async principal => principal === localPrincipal || (oauth?.hasAccess(principal) ?? false),
      source: appEventSource(bridge.hub, device, utterances, config.route), post: options.eventPost,
      onError: reason => logger.warn("events_error", { reason }),
    }, config.events);
    const dependencies = { device, speaker, listener: utterances, notificationCenter: notifications };
    const local = createMcpServer(dependencies, { events: events.registrar, localPrincipal });
    let publicServer: McpHttpServer | undefined;
    // Stop event delivery and retries before closing their HTTP listeners.
    cleanups.push(() => local.close());
    if (oauth) {
      publicServer = createMcpServer(dependencies, { oauth, events: events.registrar });
      cleanups.push(() => publicServer?.close());
    }
    cleanups.push(() => events.close());
    let mirror: SlackMirror | undefined;
    if (config.slack.enabled) {
      const slackSource = {
        on(_event: "utterance", callback: (utterance: { text: string; lang: string }) => void) {
          if (config.route !== "mcp") utterances.on("utterance", callback);
        },
      };
      mirror = new SlackMirror({ client: options.slackClient ?? new SocketSlackClient(config.slack, logger),
        utterances: slackSource, notifications: { submit: notice => { fillers.cancel(); notifications.submit({ ...notice, receivedAt: Date.now() }); } },
        readSentences: config.slack.readSentences, logger });
      cleanups.push(() => mirror?.dispose());
    }
    const deviceAddress = await bridge.listen();
    const localMcp = await local.listen(options.ports?.localMcp ?? (oauth ? config.localPort : config.mcp.MCP_PORT));
    let publicMcp: ListeningAddress | undefined;
    if (publicServer) publicMcp = await publicServer.listen(options.ports?.publicMcp ?? config.mcp.MCP_PORT);
    await mirror?.start();
    logger.info("application_started", { device_port: deviceAddress.port, local_mcp_port: localMcp.port, public_mcp_port: publicMcp?.port });
    return { bridge, device, speaker, notifications, utterances, events, addresses: { device: deviceAddress, localMcp, publicMcp }, close };
  } catch (error) {
    await close().catch(() => logger.error("startup_cleanup_failed"));
    throw error;
  }
}
