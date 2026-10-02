import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Phonemizer } from './kana.js';
import { abortError } from './types.js';

const responseSchema = z.union([
  z.object({ ready: z.literal(true) }),
  z.object({ id: z.number().int(), phones: z.array(z.string()).max(10000) }),
  z.object({ id: z.number().int(), error: z.literal(true) }),
]);

type Pending = { resolve: (phones: string[]) => void; reject: (error: Error) => void; cleanup: () => void };
export interface SidecarOptions {
  command?: string;
  args?: string[];
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
}

/** Start once before accepting speech. dispose() closes the process and all waits. */
export class PythonOpenJtalkSidecar implements Phonemizer {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private closed = false;
  private buffer = '';
  private readonly ready: Promise<void>;

  constructor(private readonly options: SidecarOptions = {}) {
    this.child = spawn(options.command ?? 'uv', options.args ?? [
      'run', '--no-project', '--with', 'piper-plus-g2p==0.2.0',
      '--with', 'pyopenjtalk-plus==0.4.1.post9', 'python', '-u',
      fileURLToPath(new URL('./openjtalk-sidecar.py', import.meta.url)),
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(), options.startupTimeoutMs ?? 120000);
      const fail = () => {
        clearTimeout(timer);
        reject(new Error('OpenJTalk sidecar unavailable: install uv and warm it before starting speech'));
        this.dispose();
      };
      this.child.on('error', fail);
      this.child.on('exit', () => {
        fail();
        this.failPending(new Error('OpenJTalk sidecar stopped'));
      });
      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', (chunk: string) => {
        this.buffer += chunk;
        if (this.buffer.length > 1000000) { fail(); return; }
        let end: number;
        while ((end = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, end);
          this.buffer = this.buffer.slice(end + 1);
          try {
            const message = responseSchema.parse(JSON.parse(line));
            if ('ready' in message) { clearTimeout(timer); resolve(); }
            else {
              const item = this.pending.get(message.id);
              if (!item) continue;
              this.pending.delete(message.id);
              item.cleanup();
              if ('error' in message) item.reject(new Error('OpenJTalk could not read the sentence'));
              else item.resolve(message.phones);
            }
          } catch { fail(); this.failPending(new Error('Invalid OpenJTalk response')); }
        }
      });
      // Do not expose provider warnings, source paths or input text in logs.
      this.child.stderr.resume();
      this.child.stdin.on('error', fail);
    });
    // Startup errors remain observable via start()/phonemize(), without unhandled rejection.
    void this.ready.catch(() => undefined);
  }

  async start(): Promise<void> { await this.ready; if (this.closed) throw new Error('OpenJTalk sidecar stopped'); }

  async phonemize(text: string, signal?: AbortSignal): Promise<string[]> {
    signal?.throwIfAborted();
    await this.start();
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const cancel = () => {
        const item = this.pending.get(id);
        this.pending.delete(id);
        item?.cleanup();
        reject(abortError());
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        signal?.removeEventListener('abort', cancel);
        reject(new Error('OpenJTalk conversion timed out'));
      }, this.options.requestTimeoutMs ?? 5000);
      this.pending.set(id, { resolve, reject, cleanup: () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
      } });
      signal?.addEventListener('abort', cancel, { once: true });
      this.child.stdin.write(JSON.stringify({ id, text }) + '\n');
    });
  }

  private failPending(error: Error): void {
    for (const item of this.pending.values()) { item.cleanup(); item.reject(error); }
    this.pending.clear();
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.failPending(new Error('OpenJTalk sidecar stopped'));
    this.child.kill();
  }
}
