import { Agent, buildConnector, fetch } from 'undici';
import type { TtsLog } from './types.js';
import { requestScope } from './http.js';

/** Two persistent sockets allow sentence N+1 to start while N's body is open. */
export class OpenAiTransport {
  private readonly agent: Agent;
  private connection = 0;

  constructor(private readonly log?: TtsLog) {
    const connect = buildConnector({ timeout: 10000, keepAlive: true });
    this.agent = new Agent({ connections: 2, pipelining: 1,
      keepAliveTimeout: 60000, keepAliveMaxTimeout: 60000,
      connect: (options, callback) => {
        const startedAt = performance.now();
        const connection = ++this.connection;
        connect(options, (...args) => {
          this.log?.('tts.http_connect', { level: 'debug', connection,
            connectionMs: performance.now() - startedAt, ok: args[0] === null });
          callback(...args);
        });
      } });
  }

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    // The SDK supplies a URL and RequestInit. Keep credentials on that origin.
    return await fetch(input as string, { ...init as Parameters<typeof fetch>[1],
      dispatcher: this.agent, redirect: 'error' }) as unknown as Response;
  };

  async warmup(baseURL: string): Promise<void> {
    const scope = requestScope(10000);
    const startedAt = performance.now();
    try {
      // GET does not synthesize speech or consume billed audio. Even 401/405
      // establishes TLS; no credentials are needed. Drain the small response
      // to retain both sockets (undici resets HEAD connections by default).
      const results = await Promise.allSettled([0, 1].map(async () => {
        const response = await this.fetch(`${baseURL.replace(/\/$/, '')}/audio/speech`,
          { method: 'GET', signal: scope.signal });
        await response.arrayBuffer();
      }));
      if (results.some(result => result.status === 'rejected')) throw new Error('OpenAI TTS connection warmup failed');
      this.log?.('tts.http_warmup', { level: 'debug', warmupMs: performance.now() - startedAt, ok: true });
    } catch {
      scope.signal.throwIfAborted();
      throw new Error('OpenAI TTS connection warmup failed');
    } finally { scope.dispose(); }
  }

  async dispose(): Promise<void> { await this.agent.destroy(); }
}
