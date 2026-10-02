import type { Socket } from 'node:net';
import { listenFake, readJson, sinePcm } from './fake-local-tts.js';

/** Real HTTP, with headers early and PCM after 300ms, then every 50ms. */
export async function startFakeOpenAiTts() {
  const connections = new Set<Socket>();
  const warmSockets = new Set<Socket>();
  const requests: { body: Record<string, unknown>; startedAt: number; firstByteAt?: number;
    endedAt?: number; closedAt?: number; socket: Socket }[] = [];
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = await listenFake((request, response) => {
    connections.add(request.socket);
    if (request.method === 'GET') {
      warmSockets.add(request.socket);
      response.writeHead(405).end();
      return;
    }
    void readJson(request).then(body => {
      const entry: typeof requests[number] = { body, startedAt: performance.now(), socket: request.socket };
      requests.push(entry);
      response.on('close', () => { entry.closedAt = performance.now(); });
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      response.flushHeaders();
      const chunk = sinePcm(24000, 1, 's16le', 0.05);
      let count = 0;
      const schedule = (ms: number, run: () => void) => {
        const timer = setTimeout(() => { timers.delete(timer); if (!response.destroyed) run(); }, ms);
        timers.add(timer);
      };
      const write = () => {
        entry.firstByteAt ??= performance.now();
        response.write(chunk);
        if (++count < 10) schedule(50, write);
        else schedule(50, () => { entry.endedAt = performance.now(); response.end(); });
      };
      schedule(300, write);
    }).catch(() => response.destroy());
  });
  return { ...server, requests, connections, warmSockets, close: async () => {
    for (const timer of timers) clearTimeout(timer);
    await server.close();
  } };
}
