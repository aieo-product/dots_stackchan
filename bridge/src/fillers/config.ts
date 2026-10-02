import { z } from "zod";

const phrase = z.strictObject({ kind: z.enum(["ack", "wait"]), text: z.string().trim().min(1).max(100) });
const phrases = z.array(phrase).max(5);
export type FillerConfig = z.infer<typeof phrases>;
export function readFillerConfig(env: NodeJS.ProcessEnv): FillerConfig {
  if (env.FILLER_PHRASES === "") return [];
  return phrases.parse(env.FILLER_PHRASES === undefined ? [
    { kind: "ack", text: "うん、聞いてみるね" },
    { kind: "ack", text: "うん、わかったよ" },
    { kind: "ack", text: "ちょっと考えるね" },
    { kind: "ack", text: "うん、聞こえたよ" },
    { kind: "wait", text: "まだ調べてるよ" },
  ] : JSON.parse(env.FILLER_PHRASES));
}
