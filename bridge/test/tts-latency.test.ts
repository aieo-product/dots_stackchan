import { afterEach, expect, test, vi } from 'vitest';
import { OpenAiTtsEngine } from '../src/tts/openai.js';
import { SpeechQueue } from '../src/tts/speech-queue.js';
import { TtsRouter } from '../src/tts/router.js';
import { ttsEnvSchema } from '../src/tts/config.js';
import { FakeDevice } from './fixtures/tts/fakes.js';
import { startFakeOpenAiTts } from './fixtures/fake-openai-tts.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const text = 'こんにちは。今日もいっしょにがんばろうね。';

function setup(engine: OpenAiTtsEngine, log = vi.fn()) {
  const device = new FakeDevice();
  const frameTimes: { seq: number; at: number }[] = [];
  const sendBinary = device.sendBinary.bind(device);
  device.sendBinary = (kind, seq, bytes) => { frameTimes.push({ seq, at: performance.now() }); sendBinary(kind, seq, bytes); };
  const router = new TtsRouter({ VOICE_MODE: 'bridge', TTS_ENGINE: 'openai' },
    { convert: async () => { throw new Error('Unexpected kana conversion'); } }, () => engine);
  const queue = new SpeechQueue(device, router, { log });
  cleanups.push(() => router.dispose(), () => queue.dispose());
  return { device, frameTimes, queue, log };
}

test('slow HTTP PCM streams before EOF; one-sentence prefetch starts on the first sent frame and reuses warm sockets', async () => {
  const server = await startFakeOpenAiTts(); cleanups.push(server.close);
  const log = vi.fn();
  const engine = OpenAiTtsEngine.create(ttsEnvSchema.parse({}), '<test-token>', { baseURL: `${server.url}/v1`, log });
  const { device, frameTimes, queue } = setup(engine, log);
  await engine.warmup();
  expect(server.warmSockets.size).toBe(2);
  const ticket = queue.say(text + 'これは三番目の長い文章です。');
  await vi.waitFor(() => expect(server.requests).toHaveLength(2));
  const firstFrame = frameTimes.find(frame => frame.seq === 1);
  expect(firstFrame).toBeDefined();
  if (!firstFrame) throw new Error('Missing first frame');
  expect(firstFrame.at - server.requests[0].startedAt).toBeGreaterThanOrEqual(290);
  expect(server.requests[1].startedAt).toBeGreaterThanOrEqual(firstFrame.at);
  expect(server.requests[0].endedAt).toBeUndefined();
  expect(device.binaries.every(frame => frame.seq === 1)).toBe(true);
  await vi.waitFor(() => expect(device.messages).toContainEqual({ type: 'tts.end', seq: 1 }));
  expect(server.requests[1].startedAt).toBeLessThan(Number(server.requests[0].endedAt));
  expect(server.requests).toHaveLength(2); // N+2 cannot start while N awaits done.
  device.done(1);
  await vi.waitFor(() => expect(server.requests).toHaveLength(3));
  expect(server.requests[2].startedAt).toBeGreaterThanOrEqual(Number(frameTimes.find(frame => frame.seq === 2)?.at));
  await vi.waitFor(() => expect(device.messages).toContainEqual({ type: 'tts.end', seq: 2 }));
  device.done(2);
  await vi.waitFor(() => expect(device.messages).toContainEqual({ type: 'tts.end', seq: 3 }));
  device.done(3); await ticket.done;
  expect(server.connections.size).toBe(2);
  expect(server.requests.every(request => server.warmSockets.has(request.socket))).toBe(true);
  expect(device.binaries.reduce((sum, frame) => sum + frame.data.length, 0)).toBe(48000);
  expect(device.binaries.every(frame => frame.data.length % 2 === 0 && frame.data.length <= 4092)).toBe(true);
  const events = log.mock.calls.map(call => call[0]);
  for (const event of ['tts.http_connect', 'tts.http_warmup', 'tts.http_request', 'tts.http_headers',
    'tts.http_first_byte', 'tts.conversion_first', 'tts.conversion', 'tts.sent']) expect(events).toContain(event);
  expect(JSON.stringify(log.mock.calls)).not.toContain(text);
  console.info(JSON.stringify({ source: 'fake-openai', ...log.mock.calls.find(call => call[0] === 'tts.first_audio')?.[1] }));
  expect(log.mock.calls.find(call => call[0] === 'tts.first_audio')?.[1].replyToFirstAudioMs).toBeLessThan(800);
}, 10000);

test('slow active and prefetched HTTP bodies close on interruption, with no late frames', async () => {
  const server = await startFakeOpenAiTts(); cleanups.push(server.close);
  const engine = OpenAiTtsEngine.create(ttsEnvSchema.parse({}), '<test-token>', { baseURL: `${server.url}/v1` });
  const { device, queue } = setup(engine);
  const old = queue.say(text);
  await vi.waitFor(() => expect(server.requests).toHaveLength(2));
  queue.cancelAll();
  await expect(old.done).rejects.toThrow();
  const count = device.binaries.length;
  await vi.waitFor(() => expect(server.requests.every(request => request.closedAt !== undefined)).toBe(true));
  expect(device.binaries).toHaveLength(count);
  expect(device.messages.at(-1)?.type).toBe('tts.cancel');
});

async function measureFiveRuns(engine: OpenAiTtsEngine, log: ReturnType<typeof vi.fn>, source: string, model: string) {
  const { device, queue } = setup(engine, log); device.autoDone = true;
  await engine.warmup();
  const runs: number[] = [];
  for (let run = 1; run <= 5; run++) {
    log.mockClear();
    await queue.say(text).done;
    const first = log.mock.calls.find(call => call[0] === 'tts.first_audio')?.[1];
    expect(first).toBeDefined();
    runs.push(Number(first?.replyToFirstAudioMs));
    console.info(JSON.stringify({ source, run, model, timings: log.mock.calls }));
  }
  const medianMs = [...runs].sort((a, b) => a - b)[2];
  console.info(JSON.stringify({ source, runs, medianMs, targetMs: 800 }));
  expect(medianMs).toBeLessThanOrEqual(800);
}

test('fake OpenAI: five warmed slow-stream runs have a median <=800ms', async () => {
  const server = await startFakeOpenAiTts(); cleanups.push(server.close);
  const log = vi.fn();
  const options = ttsEnvSchema.parse({});
  const engine = OpenAiTtsEngine.create(options, '<test-token>', { baseURL: `${server.url}/v1`, log });
  await measureFiveRuns(engine, log, 'fake-openai', options.TTS_MODEL);
  expect(server.requests).toHaveLength(10);
  expect(server.connections.size).toBe(2);
}, 15000);

test.skipIf(!process.env.OPENAI_API_KEY)('real OpenAI: five warmed reply-to-first-PCM runs, median <=800ms', async () => {
  const log = vi.fn();
  const options = ttsEnvSchema.parse({ ...process.env, VOICE_MODE: 'bridge', TTS_ENGINE: 'openai' });
  const engine = OpenAiTtsEngine.create(options, process.env.OPENAI_API_KEY, { log });
  await measureFiveRuns(engine, log, 'real-openai', options.TTS_MODEL);
}, 180000);
