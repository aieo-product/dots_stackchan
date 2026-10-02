export const EXPRESSIONS = [
  "neutral",
  "happy",
  "sad",
  "doubt",
  "sleepy",
  "angry",
] as const;

export type Expression = (typeof EXPRESSIONS)[number];

export interface DeviceMessage {
  type: string;
  [key: string]: unknown;
}

export interface DeviceLink {
  send(message: DeviceMessage): void;
  sendBinary(kind: number, seq: number, data: Uint8Array): void;
  on(event: "message", callback: (message: unknown) => void): void;
  readonly online: boolean;
  readonly caps: {
    readonly sanotts: boolean;
    readonly servo: boolean;
    readonly mic: boolean;
  };
}

export interface SpeechTicket {
  readonly id: string;
  readonly estimatedSeconds: number;
  readonly done: Promise<void>;
}

export interface Speaker {
  say(
    text: string,
    opts?: { expression?: Expression; interrupt?: boolean },
  ): SpeechTicket;
  cancelAll(): void;
}

export interface Listener {
  nextUtterance(timeoutMs: number): Promise<{ text: string } | null>;
}
