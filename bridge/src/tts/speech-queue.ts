import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { DeviceLink, DeviceMessage, TtsLog } from './types.js';
import { abortError, abortable } from './types.js';
import type { Expression, Speaker, SpeechTicket, SayOptions } from './speaker.js';
import { segment } from './segment.js';
import { TtsRouter } from './router.js';

interface Job {
  text: string; expression?: Expression; purpose?: SayOptions['purpose']; queuedAt: number;
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

  say(text: string, opts: SayOptions = {}): SpeechTicket {
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
    this.jobs.push({ text: clipped, expression: opts.expression, purpose: opts.purpose, queuedAt: performance.now(), resolve, reject });
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
          const prepare = (sentence: string, index: number) => {
            const startedAt = performance.now();
            this.log('tts.prepare', { level: 'debug', sentence: index + 1, prefetched: index > 0,
              queuedToPrepareMs: startedAt - (job?.queuedAt ?? startedAt) });
            const promise = this.router.prepare(sentence, this.device, controller.signal, job?.purpose);
            // A prefetched failure belongs to the next sentence, not the active one.
            void promise.catch(() => undefined);
            return { startedAt, promise };
          };
          let pending = sentences.length ? prepare(sentences[0], 0) : undefined;
          for (let index = 0; index < sentences.length; index++) {
            if (!pending) throw new Error('Speech preparation missing');
            const conversionAt = pending.startedAt;
            const payload = await pending.promise;
            controller.signal.throwIfAborted();
            pending = undefined;
            const prefetch = () => {
              if (index + 1 < sentences.length) pending = prepare(sentences[index + 1], index + 1);
            };
            if (payload.route === 'sanotts' && !payload.kana) { prefetch(); continue; }
            // Never reuse an identifier in this connection. Wrap could accept a late done.
            if (this.sequence >= 65535) throw new Error('Speech sequence exhausted; create a new device session');
            const seq = ++this.sequence;
            const sendAt = performance.now();
            await this.sendAndWait(seq, controller.signal, async () => {
              await this.router.send(payload, this.device, seq, controller.signal, job?.expression, () => {
                const sentAt = performance.now();
                if (payload.route !== 'sanotts') this.log('tts.first_audio', { seq, route: payload.route,
                  firstAudioMs: sentAt - conversionAt,
                  replyToFirstAudioMs: sentAt - (job?.queuedAt ?? conversionAt),
                  firstFrameSendMs: sentAt - sendAt,
                  sentence: index + 1, targetMs: 800,
                  targetMet: sentAt - (index === 0 ? job?.queuedAt ?? conversionAt : conversionAt) <= 800 });
                prefetch();
              });
              this.log('tts.sent', { seq, route: payload.route,
                sendMs: performance.now() - sendAt,
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
          // Close an unused prefetched body and its deadline even on successful exit.
          controller.abort();
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

  private async sendAndWait(seq: number, signal: AbortSignal, send: () => Promise<void>): Promise<void> {
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
    try { await Promise.all([abortable(send(), signal), wait]); }
    catch (error) { void wait.catch(() => undefined); throw error; }
    finally { clearTimeout(timer); this.device.off('message', listener); }
  }
}
