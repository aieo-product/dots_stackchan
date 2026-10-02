import OpenAI from 'openai';
import type { ServerResponse } from 'node:http';
import { afterEach, expect, test, vi } from 'vitest';
import { OpenAiTtsEngine } from '../src/tts/openai.js';
import { TtsRouter } from '../src/tts/router.js';
import { SpeechQueue } from '../src/tts/speech-queue.js';
import { FakeDevice } from './fixtures/tts/fakes.js';
import { listenFake, readJson, sinePcm } from './fixtures/fake-local-tts.js';
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function setup() {
  const bodies: Record<string, unknown>[] = []; const responses: ServerResponse[] = []; const closed: number[] = [];
  const server = await listenFake((request, response) => {
    void readJson(request).then(body => {
      const index = bodies.length; bodies.push(body); responses.push(response);
      response.on('close', () => closed.push(index));
      response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      response.write(sinePcm(24000, 1, 's16le', 0.2));
    }).catch(() => response.destroy());
  });
  cleanup.push(server.close);
  const client = new OpenAI({ apiKey: '<test-token>', baseURL: `${server.url}/v1`, maxRetries: 0 });
  const engine = new OpenAiTtsEngine({ TTS_VOICE: 'coral', TTS_INSTRUCTIONS: 'Friendly' }, client.audio.speech);
  const device = new FakeDevice(); const log = vi.fn();
  const queue = new SpeechQueue(device, new TtsRouter({ VOICE_MODE: 'bridge', TTS_ENGINE: 'openai' },
    { convert: async () => { throw new Error('unexpected kana'); } }, () => engine), { log });
  cleanup.push(() => queue.dispose());
  return { bodies, responses, closed, device, log, queue };
}

test('OpenAI first audio <800ms, N+1 HTTP starts while N streams, done gates playback', async () => {
  const { bodies, responses, device, log, queue } = await setup();
  const states: boolean[] = []; queue.on('speaking', value => states.push(value));
  const ticket = queue.say('First! Second sentence.');
  await vi.waitFor(() => expect(device.binaries.length).toBeGreaterThan(0));
  await vi.waitFor(() => expect(bodies).toHaveLength(2));
  expect(bodies.map(body => body.input)).toEqual(['First!', 'Second sentence.']);
  expect(bodies[0]).toMatchObject({ response_format: 'pcm', voice: 'coral', instructions: 'Friendly' });
  expect(device.messages.some(message => message.type === 'tts.end')).toBe(false);
  expect(device.binaries.every(frame => frame.seq === 1)).toBe(true);
  const latency = log.mock.calls.find(call => call[0] === 'tts.first_audio')?.[1];
  expect(latency).toMatchObject({ sentence: 1, targetMet: true });
  expect(latency?.replyToFirstAudioMs).toBeLessThan(800);
  console.log(`Fake OpenAI reply-to-first-audio: ${Number(latency?.replyToFirstAudioMs).toFixed(1)}ms`);
  responses[0].end();
  await vi.waitFor(() => expect(device.messages.at(-1)).toMatchObject({ type: 'tts.end', seq: 1 }));
  expect(device.binaries.every(frame => frame.seq === 1)).toBe(true);
  device.done(1); responses[1].end();
  await vi.waitFor(() => expect(device.messages.at(-1)).toMatchObject({ type: 'tts.end', seq: 2 }));
  device.done(2); await ticket.done;
  expect(states).toEqual([true, false]);
  expect(log.mock.calls.filter(call => call[0] === 'tts.first_audio')).toHaveLength(2);
  expect(device.binaries.every(frame => frame.data.length % 2 === 0 && frame.data.length + 3 <= 4096)).toBe(true);
  expect(device.binaries.reduce((total, frame) => total + frame.data.length, 0)).toBe(12800);
});
test('interrupt aborts active and prefetched HTTP bodies; no late frames; next ticket works', async () => {
  const { bodies, responses, closed, device, queue } = await setup();
  const first = queue.say('Old! Prefetched sentence.');
  await vi.waitFor(() => expect(bodies).toHaveLength(2));
  await vi.waitFor(() => expect(device.binaries.length).toBeGreaterThan(0));
  const next = queue.say('New!', { interrupt: true });
  await expect(first.done).rejects.toThrow();
  await vi.waitFor(() => expect(closed).toEqual(expect.arrayContaining([0, 1])));
  await vi.waitFor(() => expect(bodies).toHaveLength(3));
  const oldCount = device.binaries.filter(frame => frame.seq === 1).length;
  responses[2].end();
  await vi.waitFor(() => expect(device.messages.at(-1)).toMatchObject({ type: 'tts.end', seq: 2 }));
  device.done(1); device.done(2); await next.done;
  expect(device.messages.some(message => message.type === 'tts.cancel')).toBe(true);
  expect(device.binaries.filter(frame => frame.seq === 1)).toHaveLength(oldCount);
  expect(device.messages.filter(message => message.type === 'tts.end').map(message => message.seq)).toEqual([2]);
});

test('device rejection mid-stream closes HTTP and completion listeners', async () => {
  const { bodies, closed, device, queue } = await setup();
  const ticket = queue.say('Rejected!');
  await vi.waitFor(() => expect(bodies).toHaveLength(1));
  await vi.waitFor(() => expect(device.binaries.length).toBeGreaterThan(0));
  device.done(1, false);
  await expect(ticket.done).rejects.toThrow('failed');
  await vi.waitFor(() => expect(closed).toContain(0));
  expect(device.messages.at(-1)).toMatchObject({ type: 'tts.cancel' });
  expect(device.listenerCount('message')).toBe(0);
});
