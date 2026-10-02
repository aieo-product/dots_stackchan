import { SocketModeClient } from "@slack/socket-mode";
import { LogLevel, WebClient } from "@slack/web-api";
import { z } from "zod";

import { createLogger, type Logger } from "../log.js";
import type { EnabledSlackConfig } from "./config.js";

export type SlackStatus = "offline" | "connecting" | "online" | "reconnecting";
export interface SlackSession { channel: string; ownUserId: string; dotUserId: string }
export interface SlackMessage {
  type: "message";
  channel: string;
  text: string;
  ts: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  thread_ts?: string;
  hasTable?: boolean;
}

export interface SlackClient {
  readonly session: SlackSession | undefined;
  readonly status: SlackStatus;
  start(): Promise<void>;
  stop(): Promise<void>;
  post(text: string): Promise<void>;
  onMessage(cb: (message: SlackMessage) => void): () => void;
  onStatus(cb: (status: SlackStatus) => void): () => void;
}

const messageSchema = z.object({
  type: z.literal("message"), channel: z.string(), channel_type: z.literal("im"),
  text: z.string().default(""), ts: z.string().min(1),
  user: z.string().optional(), bot_id: z.string().optional(), subtype: z.string().optional(),
  thread_ts: z.string().optional(), blocks: z.array(z.object({ type: z.string() })).optional(),
});
const envelopeSchema = z.object({
  type: z.literal("events_api"),
  ack: z.custom<() => Promise<void>>((value) => typeof value === "function"),
  body: z.object({ type: z.literal("event_callback"), event: z.unknown() }),
});

/** SDK log arguments can contain tokens, payloads and private URLs. Discard them entirely. */
function sdkLogger(logger: Logger) {
  return {
    debug: () => {}, info: () => {},
    warn: () => logger.warn("slack_sdk_warning"),
    error: () => logger.error("slack_sdk_error"),
    getLevel: () => LogLevel.ERROR, setLevel: () => {}, setName: () => {},
  };
}

/** One user-authorized DM; the SDK owns WebSocket reconnection and heartbeat handling. */
export class SocketSlackClient implements SlackClient {
  private readonly web: WebClient;
  private readonly socket: SocketModeClient;
  private readonly messages = new Set<(message: SlackMessage) => void>();
  private readonly statuses = new Set<(status: SlackStatus) => void>();
  private running = false;
  private starting: Promise<void> | undefined;
  private currentSession: SlackSession | undefined;
  private currentStatus: SlackStatus = "offline";

  constructor(private readonly config: EnabledSlackConfig, private readonly logger: Logger = createLogger()) {
    const safeLogger = sdkLogger(logger);
    this.web = new WebClient(config.userToken, {
      logger: safeLogger, timeout: 10_000,
      // A timed-out write might already have reached Slack; do not retry it and post twice.
      retryConfig: { retries: 0 }, rejectRateLimitedCalls: true,
    });
    this.socket = new SocketModeClient({
      appToken: config.appToken, logger: safeLogger, autoReconnectEnabled: true,
      clientOptions: { timeout: 10_000 },
    });
    this.socket.on("connected", () => { if (this.running) this.setStatus("online"); });
    this.socket.on("connecting", () => { if (this.running) this.setStatus("connecting"); });
    for (const event of ["reconnecting", "close"]) {
      this.socket.on(event, () => { if (this.running) this.setStatus("reconnecting"); });
    }
    this.socket.on("disconnected", () => this.setStatus("offline"));
    this.socket.on("error", () => {
      this.logger.error("slack_connection_failed");
      if (this.running) this.setStatus("reconnecting");
    });
    this.socket.on("slack_event", (envelope: unknown) => { void this.receive(envelope); });
  }

  get session(): SlackSession | undefined { return this.currentSession; }
  get status(): SlackStatus { return this.currentStatus; }

  onMessage(cb: (message: SlackMessage) => void): () => void {
    this.messages.add(cb);
    return () => { this.messages.delete(cb); };
  }

  onStatus(cb: (status: SlackStatus) => void): () => void {
    this.statuses.add(cb);
    return () => { this.statuses.delete(cb); };
  }

  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.running) return Promise.resolve();
    this.running = true;
    this.setStatus("connecting");
    this.starting = this.connect().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async connect(): Promise<void> {
    try {
      const auth = await this.web.auth.test();
      if (!auth.ok || !auth.user_id || auth.bot_id) throw new Error("Invalid Slack user authorization");
      const channel = await this.findDm();
      if (!this.running) return;
      this.currentSession = { channel, ownUserId: auth.user_id, dotUserId: this.config.dotUserId };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.socket.start(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Slack connection timeout")), 15_000);
            timer.unref();
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (!this.running) await this.socket.disconnect();
    } catch {
      this.running = false;
      this.currentSession = undefined;
      await this.socket.disconnect().catch(() => this.logger.error("slack_disconnect_failed"));
      this.setStatus("offline");
      this.logger.error("slack_start_failed");
      throw new Error("Slack start failed; check authorization and the existing DM configuration");
    }
  }

  private async findDm(): Promise<string> {
    let cursor: string | undefined;
    const cursors = new Set<string>();
    do {
      const page = await this.web.conversations.list({ types: "im", limit: 200, cursor });
      if (!page.ok) throw new Error("Slack DM lookup failed");
      for (const dm of page.channels ?? []) {
        if (!dm.is_im || !dm.id || !dm.user) continue;
        if (this.config.channel && dm.id !== this.config.channel) continue;
        if (this.config.dotUserId.startsWith("B")) {
          const peer = await this.web.users.info({ user: dm.user });
          if (!peer.ok || peer.user?.profile?.bot_id !== this.config.dotUserId) continue;
        } else if (dm.user !== this.config.dotUserId) continue;
        return dm.id;
      }
      cursor = page.response_metadata?.next_cursor?.trim() || undefined;
      if (cursor && cursors.has(cursor)) throw new Error("Slack DM pagination failed");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    throw new Error("Existing Dot DM not found");
  }

  async stop(): Promise<void> {
    this.running = false;
    this.setStatus("offline");
    // Disconnect first to release a start() waiting for the WebSocket hello.
    await this.socket.disconnect().catch(() => this.logger.error("slack_disconnect_failed"));
    await this.starting?.catch(() => {});
    this.currentSession = undefined;
  }

  async post(text: string): Promise<void> {
    if (!this.running || this.status !== "online" || !this.session) throw new Error("Slack is offline");
    if (!text.trim()) return;
    try {
      const response = await this.web.chat.postMessage({
        channel: this.session.channel, text, mrkdwn: false, parse: "none",
        unfurl_links: false, unfurl_media: false,
      });
      if (!response.ok) throw new Error("Slack post failed");
    } catch {
      this.logger.error("slack_post_failed");
      throw new Error("Slack post failed");
    }
  }

  private async receive(raw: unknown): Promise<void> {
    const envelope = envelopeSchema.safeParse(raw);
    // Other Socket Mode envelopes also require acknowledgement.
    const ack = z.object({ ack: z.custom<() => Promise<void>>((value) => typeof value === "function") })
      .safeParse(raw);
    if (!ack.success) return;
    try {
      await ack.data.ack();
    } catch {
      this.logger.warn("slack_ack_failed");
      return;
    }
    if (!this.running || !envelope.success) return;
    const message = messageSchema.safeParse(envelope.data.body.event);
    if (!message.success) return;
    const { blocks, ...data } = message.data;
    try {
      for (const cb of this.messages) cb({ ...data, hasTable: blocks?.some((block) => block.type === "table") });
    } catch {
      this.logger.error("slack_message_handler_failed");
    }
  }

  private setStatus(status: SlackStatus): void {
    if (status === this.currentStatus) return;
    this.currentStatus = status;
    this.logger.info("slack_status", { status });
    for (const cb of this.statuses) {
      try { cb(status); } catch { this.logger.error("slack_status_handler_failed"); }
    }
  }
}
