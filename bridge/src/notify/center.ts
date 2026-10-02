import type { DeviceLink, Speaker } from "../mcp/dependencies.js";

export interface Notification {
  readonly message: string;
  readonly priority: "normal" | "high";
  readonly topicId?: string;
}

export interface NotificationCenter {
  notify(notification: Notification): Promise<void>;
}

export function createNotificationCenter(dependencies: {
  device: DeviceLink;
  speaker: Speaker;
}): NotificationCenter {
  return {
    async notify(notification): Promise<void> {
      dependencies.device.send({ type: "chime", kind: "notify" });
      await dependencies.speaker.say(notification.message, {
        interrupt: notification.priority === "high",
      });
    },
  };
}
