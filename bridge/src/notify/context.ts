export interface ReplyContext {
  readonly reply_to: string;
}

export class NotificationContext {
  #last: { topicId: string; finishedAt: number } | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  recordPlayback(topicId: string | undefined, finishedAt = this.now()): void {
    this.#last = topicId === undefined ? undefined : { topicId, finishedAt };
  }

  /** #10 can pass the utterance start time, before transcription completes. */
  forUtterance(startedAt = this.now()): ReplyContext | undefined {
    if (this.#last === undefined) return undefined;
    const age = startedAt - this.#last.finishedAt;
    return age >= 0 && age <= 10_000 ? { reply_to: this.#last.topicId } : undefined;
  }
}
