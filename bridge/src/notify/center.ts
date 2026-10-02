import { createHash } from "node:crypto";

import type { DeviceLink, Speaker } from "../mcp/dependencies.js";
import { notificationConfigSchema, type NotificationConfig } from "./config.js";
import { NotificationContext } from "./context.js";
import { isQuietHours, quietHoursEnd } from "./quiet-hours.js";

export interface Notification {
  readonly source: "mcp" | "slack";
  readonly message: string;
  readonly priority: "normal" | "high";
  readonly topicId?: string;
  readonly receivedAt: number;
}

export interface NotificationLog {
  readonly event: "queued" | "duplicate" | "played" | "failed";
  readonly source: Notification["source"];
  readonly priority: Notification["priority"];
  readonly message?: string;
}

export interface NotificationCenter {
  submit(notification: Notification): "queued" | "duplicate";
  readonly pendingCount: number;
  readonly context: NotificationContext;
  dispose(): void;
}

interface PendingNotification {
  readonly notification: Notification;
  releasedByTouch: boolean;
}

const CONVERSATION_STATES = new Set(["listening", "thinking", "speaking"]);
const IDLE_DELAY_MS = 2_000;

export function createNotificationCenter(dependencies: {
  device: DeviceLink;
  speaker: Speaker;
  config?: NotificationConfig;
  now?: () => number;
  log?: (entry: NotificationLog) => void;
  isSpeaking?: () => boolean;
}): NotificationCenter {
  const { device, speaker } = dependencies;
  const now = dependencies.now ?? Date.now;
  const config = dependencies.config ?? notificationConfigSchema.parse(process.env);
  const context = new NotificationContext(now);
  const pending: PendingNotification[] = [];
  const seen = new Map<string, number>();
  let state = "idle";
  let idleSince = now();
  let playing = false;
  let disposed = false;
  let reportedCount: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function log(event: NotificationLog["event"], notification: Notification): void {
    const entry: NotificationLog = {
      event,
      source: notification.source,
      priority: notification.priority,
      ...(config.LOG_NOTIFICATIONS ? { message: notification.message } : {}),
    };
    // Logging failures must not break delivery; never log exception contents.
    try {
      (dependencies.log ?? ((value) => console.info("notification", value)))(entry);
    } catch { /* The notification queue remains usable. */ }
  }

  function reportPending(): void {
    if (!device.online || reportedCount === pending.length) return;
    try {
      device.send({ type: "notice.pending", count: pending.length });
      reportedCount = pending.length;
    } catch { /* Retry the count on the next queue or device event. */ }
  }

  function schedule(at: number): void {
    timer = setTimeout(pump, Math.min(2_147_483_647, Math.max(1, at - now())));
    timer.unref();
  }

  function pump(): void {
    clearTimeout(timer);
    timer = undefined;
    if (disposed) return;
    reportPending();
    if (playing || pending.length === 0 || !device.online || dependencies.isSpeaking?.()) return;

    const at = now();
    const quiet = isQuietHours(config.QUIET_HOURS, at);
    const quietEnd = quiet && config.QUIET_HOURS !== undefined
      ? quietHoursEnd(config.QUIET_HOURS, at) : Infinity;
    let wakeAt = Infinity;
    let selected = -1;
    for (let index = 0; index < pending.length; index += 1) {
      const item = pending[index];
      const high = item.notification.priority === "high";
      if (quiet && !item.releasedByTouch && !(high && config.QUIET_ALLOW_HIGH)) {
        wakeAt = Math.min(wakeAt, quietEnd);
        continue;
      }
      if (state === "speaking" || (!high && CONVERSATION_STATES.has(state))) continue;
      if (!high && at < idleSince + IDLE_DELAY_MS) {
        wakeAt = Math.min(wakeAt, idleSince + IDLE_DELAY_MS);
        continue;
      }
      if (selected === -1 || (high && pending[selected].notification.priority !== "high")) {
        selected = index;
      }
    }
    if (selected === -1) {
      if (Number.isFinite(wakeAt)) schedule(wakeAt);
      return;
    }

    const { notification } = pending.splice(selected, 1)[0];
    playing = true;
    reportPending();
    try {
      device.send({ type: "chime", kind: "notify" });
      const ticket = speaker.say(notification.message, { interrupt: false, purpose: "notification" });
      void ticket.done.then(
        () => finish(notification, true),
        () => finish(notification, false),
      );
    } catch {
      finish(notification, false);
    }
  }

  function finish(notification: Notification, succeeded: boolean): void {
    if (disposed) return;
    playing = false;
    if (succeeded) context.recordPlayback(notification.topicId, now());
    log(succeeded ? "played" : "failed", notification);
    queueMicrotask(pump);
  }

  device.on("message", (message) => {
    if (disposed || typeof message !== "object" || message === null) return;
    const value = message as Record<string, unknown>;
    if (value.type === "state" && typeof value.state === "string") {
      const wasBusy = CONVERSATION_STATES.has(state);
      state = value.state;
      if (wasBusy && !CONVERSATION_STATES.has(state)) idleSince = now();
    } else if (value.type === "event" && value.kind === "touch") {
      for (const item of pending) item.releasedByTouch = true;
    }
    // Refresh the display after hello, or after observing an offline event.
    if (value.type === "hello" || !device.online) reportedCount = undefined;
    pump();
  });

  return {
    context,
    get pendingCount(): number { return pending.length; },
    submit(notification): "queued" | "duplicate" {
      if (disposed) throw new Error("NotificationCenter is disposed.");
      const normalized = notification.message.normalize("NFKC").replace(/\s+/gu, " ").trim();
      if (normalized.length === 0 || !Number.isFinite(notification.receivedAt)) {
        throw new Error("A notification needs a message and a finite receivedAt.");
      }
      const at = now();
      const windowMs = config.NOTIFY_DEDUP_WINDOW_S * 1_000;
      for (const [hash, acceptedAt] of seen) {
        if (at - acceptedAt >= windowMs) seen.delete(hash);
      }
      const hash = createHash("sha256").update(normalized).digest("hex");
      if (seen.has(hash)) {
        log("duplicate", notification);
        return "duplicate";
      }
      seen.set(hash, at);
      pending.push({ notification: { ...notification }, releasedByTouch: false });
      log("queued", notification);
      pump();
      return "queued";
    },
    dispose(): void {
      disposed = true;
      clearTimeout(timer);
      pending.length = 0;
      seen.clear();
    },
  };
}
