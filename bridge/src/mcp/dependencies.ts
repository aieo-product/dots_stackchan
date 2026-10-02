import { faceSchema } from "../protocol.js";
export const EXPRESSIONS = faceSchema.shape.expression.options;

export type { Expression, Speaker, SpeechTicket } from "../tts/speaker.js";
export type { DeviceMessage } from "../tts/types.js";
import type { DeviceLink as TtsDeviceLink } from "../tts/types.js";

// Tools only need the message surface, not transport teardown hooks.
export type DeviceLink = Pick<TtsDeviceLink, "send" | "sendBinary" | "online" | "caps"> & {
  on(event: "message", callback: (message: unknown) => void): void;
};

export interface Listener {
  nextUtterance(timeoutMs: number): Promise<{ text: string } | null>;
}
