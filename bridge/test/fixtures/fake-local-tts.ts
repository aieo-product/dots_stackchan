import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export function sinePcm(rate = 48000, channels = 1, format: 's16le' | 'f32le' = 's16le', seconds = 0.1): Uint8Array {
  const width = format === 's16le' ? 2 : 4;
  const count = Math.floor(rate * seconds);
  const bytes = new Uint8Array(count * channels * width);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < count; i++) for (let c = 0; c < channels; c++) {
    const sample = Math.sin(2 * Math.PI * 440 * i / rate) * 0.3;
    if (width === 2) view.setInt16((i * channels + c) * width, Math.round(sample * 32767), true);
    else view.setFloat32((i * channels + c) * width, sample, true);
  }
  return bytes;
}
export function sineWav(rate = 48000, channels = 1, format: 's16le' | 'f32le' = 's16le'): Uint8Array {
  const pcm = sinePcm(rate, channels, format);
  const width = format === 's16le' ? 2 : 4;
  const bytes = new Uint8Array(44 + pcm.length); const view = new DataView(bytes.buffer);
  const ascii = (offset: number, value: string) => bytes.set(new TextEncoder().encode(value), offset);
  ascii(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, width === 2 ? 1 : 3, true);
  view.setUint16(22, channels, true); view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * width, true); view.setUint16(32, channels * width, true);
  view.setUint16(34, width * 8, true); ascii(36, 'data'); view.setUint32(40, pcm.length, true);
  bytes.set(pcm, 44); return bytes;
}
export async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const bytes of request) chunks.push(Buffer.from(bytes));
  return JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
}
export async function listenFake(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, 'localhost', resolve));
  return { url: `http://localhost:${(server.address() as AddressInfo).port}`,
    close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}

/** Contract v1 reference server: one sentence -> 48kHz sine WAV; no model/key. */
export async function startFakeLocalTts(options: { audio?: Uint8Array; contentType?: string; status?: number; delayMs?: number; health?: number } = {}) {
  const requests: { body: Record<string, unknown>; authorization?: string }[] = [];
  const pending = new Set<ReturnType<typeof setTimeout>>();
  const server = await listenFake((request, response) => {
    void (async () => {
      if (request.url === '/health') { response.writeHead(options.health ?? 200).end(); return; }
      if (request.method !== 'POST' || request.url !== '/tts') { response.writeHead(404).end(); return; }
      const body = await readJson(request);
      requests.push({ body, authorization: request.headers.authorization });
      if (typeof body.text !== 'string' || Array.from(body.text).length > 500) { response.writeHead(400).end(JSON.stringify({ error: 'Invalid text' })); return; }
      if (options.status) { response.writeHead(options.status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'provider detail' })); return; }
      // Unknown JSON fields are deliberately ignored.
      response.writeHead(200, { 'Content-Type': options.contentType ?? 'audio/wav' });
      const audio = options.audio ?? sineWav();
      response.write(audio.subarray(0, Math.min(audio.length, 5001)));
      const timer = setTimeout(() => { pending.delete(timer); response.end(audio.subarray(5001)); }, options.delayMs ?? 1);
      pending.add(timer);
    })().catch(() => response.destroy());
  });
  return { ...server, requests, close: async () => { for (const timer of pending) clearTimeout(timer); await server.close(); } };
}
