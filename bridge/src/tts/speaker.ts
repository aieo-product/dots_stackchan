export type Expression = 'neutral' | 'happy' | 'sad' | 'doubt' | 'sleepy' | 'angry';
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
