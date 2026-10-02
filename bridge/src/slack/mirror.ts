import { createLogger, type Logger } from "../log.js";
import type { SlackClient, SlackMessage, SlackStatus } from "./client.js";
import type { NotificationSink, UtteranceSource } from "./contracts.js";
import { slackTextToSpeech } from "./text.js";

export interface SlackMirrorOptions {
  client: SlackClient;
  utterances: UtteranceSource;
  notifications: NotificationSink;
  readSentences?: number;
  logger?: Logger;
  onStatus?: (status: SlackStatus) => void;
}

/** Every new Dot post is a notification, whether solicited, unsolicited, or delayed. */
export class SlackMirror {
  private active = false;
  private readonly logger: Logger;
  private readonly seen = new Set<string>();
  private readonly detachMessage: () => void;
  private readonly detachStatus: () => void;
  private disposed = false;
  private starting: Promise<void> | undefined;

  constructor(private readonly options: SlackMirrorOptions) {
    this.logger = options.logger ?? createLogger();
    this.detachMessage = options.client.onMessage((message) => this.receive(message));
    this.detachStatus = options.client.onStatus((status) => options.onStatus?.(status));
    options.utterances.on("utterance", (utterance) => {
      if (!this.active || !utterance.text.trim()) return;
      void options.client.post(utterance.text).catch(() => this.logger.error("slack_utterance_post_failed"));
    });
  }

  start(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("Slack mirror is disposed"));
    if (this.starting) return this.starting;
    if (this.active) return Promise.resolve();
    this.active = true;
    this.starting = this.options.client.start().catch(() => {
      this.active = false;
      throw new Error("Slack mirror start failed");
    }).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  async stop(): Promise<void> {
    this.active = false;
    await this.options.client.stop();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    try { await this.stop(); } finally {
      this.detachMessage();
      this.detachStatus();
    }
    // UtteranceSource has no off() contract; its registered callback remains inert.
  }

  private receive(message: SlackMessage): void {
    const session = this.options.client.session;
    if (!this.active || !session || message.channel !== session.channel) return;
    if (message.user === session.ownUserId) return;
    if (message.user !== session.dotUserId && message.bot_id !== session.dotUserId) return;
    // Changes/deletions and system events are not new posts. Bot/file posts can carry text.
    if (message.subtype && !["bot_message", "file_share", "thread_broadcast"].includes(message.subtype)) return;
    const key = `${message.channel}:${message.ts}`;
    if (this.seen.has(key)) return;
    const text = message.hasTable ? `${message.text}\n表があるよ。` : message.text;
    const speech = slackTextToSpeech(text, this.options.readSentences);
    if (!speech) return;
    try {
      this.options.notifications.submit({
        source: "slack", message: speech, priority: "normal",
        topicId: `slack:${message.channel}:${message.thread_ts ?? message.ts}`,
      });
      this.seen.add(key);
      if (this.seen.size > 1_000) {
        const oldest = this.seen.values().next().value;
        if (oldest !== undefined) this.seen.delete(oldest);
      }
    } catch {
      this.logger.error("slack_notification_failed");
    }
  }
}
