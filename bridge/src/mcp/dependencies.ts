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

export interface Speaker {
  say(
    text: string,
    options?: { expression?: Expression; interrupt?: boolean },
  ): Promise<void>;
}

export interface Listener {
  nextUtterance(timeoutMs: number): Promise<{ text: string } | null>;
}
