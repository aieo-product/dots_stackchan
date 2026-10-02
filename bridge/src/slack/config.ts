import { z } from "zod";

const enabledSchema = z.enum(["true", "false"]).default("false");
const environmentSchema = z.object({
  SLACK_APP_TOKEN: z.string().regex(/^xapp-[A-Za-z0-9-]+$/),
  SLACK_USER_TOKEN: z.string().regex(/^xoxp-[A-Za-z0-9-]+$/),
  SLACK_DOT_USER_ID: z.string().regex(/^[UWB][A-Z0-9]+$/),
  SLACK_CHANNEL: z.string().regex(/^D[A-Z0-9]+$/).optional(),
  SLACK_READ_SENTENCES: z.coerce.number().int().min(1).max(20).default(2),
});

export interface EnabledSlackConfig {
  enabled: true;
  appToken: string;
  userToken: string;
  dotUserId: string;
  channel?: string;
  readSentences: number;
}

export type SlackConfig = { enabled: false } | EnabledSlackConfig;

/** Validate without including environment values or Zod's input in errors. */
export function loadSlackConfig(environment: NodeJS.ProcessEnv = process.env): SlackConfig {
  const enabled = enabledSchema.safeParse(environment.SLACK_ENABLED || undefined);
  if (!enabled.success) throw new Error("Invalid Slack configuration: SLACK_ENABLED");
  if (enabled.data === "false") return { enabled: false };

  const result = environmentSchema.safeParse({
    ...environment,
    SLACK_CHANNEL: environment.SLACK_CHANNEL || undefined,
    SLACK_READ_SENTENCES: environment.SLACK_READ_SENTENCES || undefined,
  });
  if (!result.success) {
    const keys = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
    throw new Error(`Invalid Slack configuration: ${keys.join(", ")}`);
  }
  return {
    enabled: true,
    appToken: result.data.SLACK_APP_TOKEN,
    userToken: result.data.SLACK_USER_TOKEN,
    dotUserId: result.data.SLACK_DOT_USER_ID,
    channel: result.data.SLACK_CHANNEL,
    readSentences: result.data.SLACK_READ_SENTENCES,
  };
}
