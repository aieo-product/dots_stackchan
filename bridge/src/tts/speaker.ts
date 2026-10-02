import type { BridgeToDeviceMessage } from '../protocol.js';
export type Expression = Extract<BridgeToDeviceMessage, { type: 'face' }>['expression'];
export interface SayOptions { expression?: Expression; interrupt?: boolean; purpose?: 'reply' | 'notification' }
export interface SpeechTicket {
  readonly id: string;
  readonly estimatedSeconds: number;
  readonly done: Promise<void>;
}
export interface Speaker {
  say(text: string, opts?: SayOptions): SpeechTicket;
  cancelAll(): void;
}
