import { z } from "zod";

export const EVENT_NAMES = [
  "stackchan.utterance",
  "stackchan.touched",
  "stackchan.online_changed",
] as const;
export const eventNameSchema = z.enum(EVENT_NAMES);
export type EventName = z.infer<typeof eventNameSchema>;
export const argumentsSchema = z.object({}).strict();

export const payloadSchemas = {
  "stackchan.utterance": z.object({
    text: z.string().min(1),
    lang: z.string().min(1).max(64),
    duration_ms: z.number().int().nonnegative(),
    reply_to: z.string().min(1).max(128).optional(),
  }).strict(),
  "stackchan.touched": z.object({ where: z.string().min(1).max(128) }).strict(),
  "stackchan.online_changed": z.object({ online: z.boolean() }).strict(),
};

export type SourceEvent = {
  [N in EventName]: { name: N; data: z.infer<(typeof payloadSchemas)[N]>; timestamp?: string }
}[EventName];

const descriptions: Record<EventName, string> = {
  "stackchan.utterance": "Speech heard by Stack-chan, including the full transcript, language, duration, and optional notification reply topic.",
  "stackchan.touched": "Stack-chan was touched at the reported location.",
  "stackchan.online_changed": "Stack-chan's device connection changed its online status.",
};

export function eventDefinition(name: EventName): Record<string, unknown> {
  return {
    name,
    description: descriptions[name],
    delivery: ["webhook"],
    inputSchema: z.toJSONSchema(argumentsSchema),
    payloadSchema: z.toJSONSchema(payloadSchemas[name]),
  };
}
