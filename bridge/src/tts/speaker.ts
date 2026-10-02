export type Expression = 'neutral' | 'happy' | 'sad' | 'doubt' | 'sleepy' | 'angry';
export interface SpeechTicket {
  readonly id: string;
  readonly estimatedSeconds: number;
  readonly done: Promise<void>;
}
export interface Speaker {
  say(text: string, opts?: { expression?: Expression; interrupt?: boolean }): SpeechTicket;
  cancelAll(): void;
}
