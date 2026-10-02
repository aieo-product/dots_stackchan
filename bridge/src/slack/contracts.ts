export type { Expression, Speaker, SpeechTicket } from "../tts/speaker.js";
import type { Notification } from "../notify/center.js";
import type { Utterance as SttUtterance } from "../stt/session.js";

export interface NotificationSink {
  submit(n: Omit<Notification, "receivedAt"> & { source: "slack" }): void;
}

export type Utterance = Pick<SttUtterance, "text" | "lang"> & { reply_to?: string };

export interface UtteranceSource {
  on(event: "utterance", cb: (u: Utterance) => void): void;
}
