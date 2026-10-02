import { z } from "zod";

import { EVENT_NAMES, type EventName } from "./catalog.js";
import { decodeKey } from "./crypto.js";

export interface EventsConfig {
  enabled: boolean;
  send: ReadonlySet<EventName>;
  storeDir: string;
  secretKey?: Buffer;
}

const schema = z.object({
  EVENTS_ENABLED: z.enum(["true", "false"]).default("true"),
  EVENTS_SEND: z.string().optional(),
  EVENTS_STORE_DIR: z.string().min(1).default(".events.local.data"),
  EVENTS_SECRET_KEY: z.string().optional(),
});

export function readEventsConfig(env: NodeJS.ProcessEnv = process.env): EventsConfig {
  const values = schema.parse(env);
  const names = values.EVENTS_SEND === undefined ? [...EVENT_NAMES] :
    values.EVENTS_SEND.split(",").map((name) => name.trim()).filter(Boolean);
  if (names.some((name) => !EVENT_NAMES.includes(name as EventName))) {
    throw new Error("EVENTS_SEND contains an unknown event name.");
  }
  const enabled = values.EVENTS_ENABLED === "true";
  if (enabled && values.EVENTS_SECRET_KEY === undefined) {
    throw new Error("EVENTS_SECRET_KEY is required when events are enabled.");
  }
  return {
    enabled,
    send: new Set(names as EventName[]),
    storeDir: values.EVENTS_STORE_DIR,
    ...(enabled ? { secretKey: decodeKey(values.EVENTS_SECRET_KEY ?? "", 32) } : {}),
  };
}
