import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { DeviceLink, DeviceMessage, TtsLog } from './types.js';
import { abortError, abortable } from './types.js';
import type { Expression, Speaker, SpeechTicket } from './speaker.js';
import { segment } from './segment.js';
import { TtsRouter } from './router.js';

interface Job {
  text: string; expression?: Expression; queuedAt: number;
  resolve(): void; reject(error: unknown): void;
}
export interface SpeechQueueOptions { maxChars?: number; doneTimeoutMs?: number; log?: TtsLog }

/** speaking(boolean) covers conversion, upload and playback, so microphones can pause. */
export class SpeechQueue extends EventEmitter implements Speaker {
  private readonly jobs: Job[] = [];
  private active?: AbortController;
  private running = false;
  private closed = false;
  private sequence = 0;
  private speaking = false;
  private readonly maxChars: number;

  constructor(private readonly device: DeviceLink, private readonly router: TtsRouter,
    private readonly options: SpeechQueueOptions = {}) {
    super();
    this.maxChars = Math.min(500, Math.max(1, Math.floor(options.maxChars ?? 500)));
  }

  say(text: string, opts: { expression?: Expression; interrupt?: boolean } = {}): SpeechTicket {
    const chars = Array.from(text);
    const clipped = chars.slice(0, this.maxChars).join('');
    const id = randomUUID();
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const done = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    // Consumers may subscribe later, after synchronous enqueue/interrupt.
    void done.catch(() => undefined);
    if (this.closed) { reject(new Error('Speech queue is disposed')); return { id, estimatedSeconds: 0, done }; }
    if (opts.interrupt) this.cancelAll();
    if (chars.length > this.maxChars) this.log('tts.truncated', { level: 'warn', originalChars: chars.length, maxChars: this.maxChars });
    this.jobs.push({ text: clipped, expression: opts.expression, queuedAt: performance.now(), resolve, reject });
    void this.drain();
    return { id, estimatedSeconds: Array.from(clipped).length * 0.15, done };
  }

  cancelAll(): void {
    const active = this.active;
    active?.abort(abortError());
    for (const job of this.jobs.splice(0)) job.reject(abortError());
    if (active && this.device.online) {
      try { this.device.send({ type: 'tts.cancel' }); } catch { this.log('tts.cancel_failed', {}); }
    }
  }

  dispose(): void { this.closed = true; this.cancelAll(); }

  private setSpeaking(value: boolean): void {
    if (this.speaking === value) return;
    this.speaking = value;
    this.emit('speaking', value);
  }

  private log(event: string, fields: Record<string, number | boolean | string>): void {
    this.options.log?.(event, fields);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let job: Job | undefined;
      while ((job = this.jobs.shift())) {
        const controller = new AbortController();
        this.active = controller;
        const offline = () => controller.abort(new Error('Speech device disconnected'));
        this.device.on('offline', offline);
        try {
          const sentences = segment(job.text);
          if (sentences.length) this.setSpeaking(true);
          for (const sentence of sentences) {
            const conversionAt = performance.now();
            const payload = await this.router.prepare(sentence, this.device, controller.signal);
            controller.signal.throwIfAborted();
            if (payload.route === 'sanotts' && !payload.kana) continue;
            // Never reuse an identifier in this connection. Wrap could accept a late done.
            if (this.sequence >= 65535) throw new Error('Speech sequence exhausted; create a new device session');
            const seq = ++this.sequence;
            await this.sendAndWait(seq, controller.signal, () => {
              this.router.send(payload, this.device, seq, controller.signal, job?.expression);
              this.log('tts.sent', { seq, route: payload.route,
                queuedToSendMs: performance.now() - (job?.queuedAt ?? conversionAt),
                conversionToSendMs: performance.now() - conversionAt });
            });
          }
          job.resolve();
        } catch (error) {
          // Stop partial PCM uploads and timeout/failed playback before the next job.
          if (!controller.signal.aborted && this.device.online) {
            try { this.device.send({ type: 'tts.cancel' }); } catch { /* disconnected */ }
          }
          this.log('tts.failed', { interrupted: controller.signal.aborted });
          job.reject(error);
        } finally {
          this.device.off('offline', offline);
          this.active = undefined;
        }
      }
    } finally {
      this.running = false;
      this.setSpeaking(false);
      // A speaking listener can enqueue synchronously.
      if (this.jobs.length) void this.drain();
    }
  }

  private async sendAndWait(seq: number, signal: AbortSignal, send: () => void): Promise<void> {
    let listener!: (message?: DeviceMessage) => void;
    let timer!: ReturnType<typeof setTimeout>;
    const done = new Promise<void>((resolve, reject) => {
      listener = message => {
        if (message?.type !== 'tts.done' || message.seq !== seq) return;
        if (message.ok === true) resolve();
        else reject(new Error('Device speech playback failed'));
      };
      this.device.on('message', listener);
      timer = setTimeout(() => reject(new Error('Device speech completion timed out')), this.options.doneTimeoutMs ?? 120000);
    });
    // Register before send, including devices that acknowledge synchronously.
    const wait = abortable(done, signal);
    try { send(); await wait; }
    catch (error) { void wait.catch(() => undefined); throw error; }
    finally { clearTimeout(timer); this.device.off('message', listener); }
  }
}
