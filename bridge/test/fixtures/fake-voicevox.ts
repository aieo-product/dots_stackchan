import { listenFake, readJson, sineWav } from './fake-local-tts.js';

export async function startFakeVoicevox() {
  const requests: { path: string; speaker: string | null; text?: string | null; body?: Record<string, unknown> }[] = [];
  const server = await listenFake((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname === '/version') { response.writeHead(200).end(JSON.stringify('test')); return; }
      if (request.method !== 'POST') { response.writeHead(405).end(); return; }
      const entry = { path: url.pathname, speaker: url.searchParams.get('speaker'), text: url.searchParams.get('text') };
      if (url.pathname === '/audio_query') {
        requests.push(entry);
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ accent_phrases: [], outputSamplingRate: 48000, outputStereo: false }));
      } else if (url.pathname === '/synthesis') {
        requests.push({ ...entry, body: await readJson(request) });
        response.writeHead(200, { 'Content-Type': 'audio/wav' }).end(sineWav());
      } else response.writeHead(404).end(JSON.stringify({ error: 'Unsupported route' }));
    })().catch(() => response.destroy());
  });
  return { ...server, requests };
}
