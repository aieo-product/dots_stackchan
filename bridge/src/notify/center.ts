import type { DeviceLink, Speaker } from "../mcp/dependencies.js";

export interface Notification {
  readonly message: string;
  readonly priority: "normal" | "high";
  readonly topicId?: string;
}

export interface NotificationCenter {
  notify(notification: Notification): void;
}

export function createNotificationCenter(dependencies: {
  device: DeviceLink;
  speaker: Speaker;
}): NotificationCenter {
  return {
    notify(notification): void {
      dependencies.device.send({ type: "chime", kind: "notify" });
      const ticket = dependencies.speaker.say(notification.message, {
        interrupt: notification.priority === "high",
      });
      // Playback can fail after the caller has received its queue acknowledgement.
      void ticket.done.catch(() => {});
    },
  };
}
