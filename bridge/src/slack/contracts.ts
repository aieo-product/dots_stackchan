import type { BridgeToDeviceMessage } from "../protocol.js";

export type Expression = Extract<BridgeToDeviceMessage, { type: "face" }>["expression"];

export interface SpeechTicket {
  readonly id: string;
  readonly estimatedSeconds: number;
  readonly done: Promise<void>;
}

export interface Speaker {
  say(text: string, opts?: { expression?: Expression; interrupt?: boolean }): SpeechTicket;
  cancelAll(): void;
}

export interface NotificationSink {
  submit(n: { source: "slack"; message: string; priority: "normal" | "high"; topicId?: string }): void;
}

export interface Utterance {
  text: string;
  lang: string;
  reply_to?: string;
}

export interface UtteranceSource {
  on(event: "utterance", cb: (u: Utterance) => void): void;
}
