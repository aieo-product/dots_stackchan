import type { Speaker, Utterance } from "./speaker.js";

interface Entry {
  utterance: Utterance;
  resolve(): void;
  reject(reason: unknown): void;
}

// One owner from synthesis through tts.done, regardless of the selected mode.
export class SpeechQueue {
  private readonly pending: Entry[] = [];
  private active?: AbortController;
  private pumping = false;
  constructor(private readonly speaker: Speaker) {}

  say(utterance: Utterance): Promise<void> {
    const receivedAt = utterance.receivedAt ?? performance.now();
    const result = new Promise<void>((resolve, reject) => {
      this.pending.push({ utterance: { ...utterance, receivedAt }, resolve, reject });
    });
    void this.pump();
    return result;
  }

  cancel(): void {
    const reason = new Error("Speech cancelled");
    for (const entry of this.pending.splice(0)) entry.reject(reason);
    this.active?.abort(reason);
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      let entry: Entry | undefined;
      while ((entry = this.pending.shift())) {
        this.active = new AbortController();
        try {
          await this.speaker.speak(entry.utterance, this.active.signal);
          entry.resolve();
        } catch (error) {
          entry.reject(error);
        } finally {
          this.active = undefined;
        }
      }
    } finally {
      this.pumping = false;
    }
  }
}
