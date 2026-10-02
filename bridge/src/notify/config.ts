import { z } from "zod";

import { parseQuietHours } from "./quiet-hours.js";

const booleanSetting = z.enum(["true", "false"]).transform((value) => value === "true");

export const notificationConfigSchema = z.object({
  QUIET_HOURS: z.string().default("22:00-07:00").transform((value, context) => {
    try {
      return parseQuietHours(value);
    } catch {
      context.addIssue({ code: "custom", message: "Invalid QUIET_HOURS; use HH:mm-HH:mm or empty." });
      return z.NEVER;
    }
  }),
  QUIET_ALLOW_HIGH: booleanSetting.prefault("false"),
  NOTIFY_DEDUP_WINDOW_S: z.coerce.number().finite().nonnegative().default(600),
  LOG_NOTIFICATIONS: booleanSetting.prefault("false"),
});

export type NotificationConfig = z.infer<typeof notificationConfigSchema>;
