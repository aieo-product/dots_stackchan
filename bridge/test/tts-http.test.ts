import { afterEach, expect, test } from 'vitest';
import { LocalHttpTtsEngine } from '../src/tts/local-http.js';
import { VoicevoxTtsEngine } from '../src/tts/voicevox.js';
import { decodeAudioResponse } from '../src/tts/audio-response.js';
import { collectAudio } from '../src/tts/audio-stream.js';
import { startFakeLocalTts, sinePcm, sineWav } from './fixtures/fake-local-tts.js';
import { startFakeVoicevox } from './fixtures/fake-voicevox.js';
const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0)) await close(); });

test('reference WAV server gets mixed text and optional fields; health; 48kHz -> 16kHz', async () => {
  const server = await startFakeLocalTts(); closes.push(server.close);
  const engine = new LocalHttpTtsEngine({ url: `${server.url}/tts`, token: '<test-token>', voice: 'test', style: 'friendly', speed: 1.1, seed: 42 });
  expect(await engine.health()).toBe('ready');
  const audio = await engine.synthesize('こんにちは。2026年です。');
  expect(audio.sampleRate).toBe(16000); expect(audio.data).toHaveLength(3200);
  expect(server.requests).toEqual([{ body: { text: 'こんにちは。2026年です。', voice: 'test', style: 'friendly', speed: 1.1, seed: 42 }, authorization: 'Bearer <test-token>' }]);
});
test.each(['s16le', 'f32le'] as const)('chunked stereo raw %s is forwarded before response ends', async format => {
  const server = await startFakeLocalTts({ audio: sinePcm(48000, 2, format),
    contentType: `audio/pcm;rate=48000;channels=2;format=${format}`, delayMs: 1000 }); closes.push(server.close);
  const abort = new AbortController();
  const stream = new LocalHttpTtsEngine({ url: `${server.url}/tts` }).stream('試験。', abort.signal);
  const start = performance.now(); const first = await stream.next();
  expect(first.done).toBe(false); expect(first.value?.length).toBeGreaterThan(0);
  expect(performance.now() - start).toBeLessThan(800);
  const pending = collectAudio(stream); abort.abort();
  await expect(pending).rejects.toThrow();
});
test('timeout applies to streaming body; server errors and invalid formats are sanitized', async () => {
  const delayed = await startFakeLocalTts({ delayMs: 1000 }); closes.push(delayed.close);
  await expect(new LocalHttpTtsEngine({ url: `${delayed.url}/tts`, timeoutMs: 20 }).synthesize('test')).rejects.toThrow('timed out');
  const failed = await startFakeLocalTts({ status: 503 }); closes.push(failed.close);
  await expect(new LocalHttpTtsEngine({ url: `${failed.url}/tts` }).synthesize('test')).rejects.toThrow('Local TTS failed');
  const unsupported = await startFakeLocalTts({ health: 404 }); closes.push(unsupported.close);
  expect(await new LocalHttpTtsEngine({ url: `${unsupported.url}/tts` }).health()).toBe('unsupported');
  expect(() => new LocalHttpTtsEngine({ url: '' })).toThrow('LOCAL_TTS_URL');
});
test('VOICEVOX posts query then synthesis with selected speaker and returned query', async () => {
  const server = await startFakeVoicevox(); closes.push(server.close);
  const engine = new VoicevoxTtsEngine(server.url, 7);
  expect(await engine.health()).toBe('ready');
  expect((await engine.synthesize('こんにちは。')).data).toHaveLength(3200);
  expect(server.requests).toEqual([
    { path: '/audio_query', speaker: '7', text: 'こんにちは。' },
    { path: '/synthesis', speaker: '7', text: null, body: { accent_phrases: [], outputSamplingRate: 48000, outputStereo: false } },
  ]);
});
test('WAV headers can be split at every byte; float stereo, truncation, encoding validation', async () => {
  const wav = sineWav(44100, 2, 'f32le');
  const response = new Response(new ReadableStream({ start(controller) {
    for (const byte of wav) controller.enqueue(Uint8Array.of(byte)); controller.close();
  } }), { headers: { 'Content-Type': 'audio/wav' } });
  expect((await collectAudio(decodeAudioResponse(response))).data).toHaveLength(3200);
  for (const audio of [wav.subarray(0, 10), wav.subarray(0, wav.length - 1)]) {
    await expect(collectAudio(decodeAudioResponse(new Response(audio as Uint8Array<ArrayBuffer>, { headers: { 'Content-Type': 'audio/wav' } })))).rejects.toThrow('Truncated');
  }
  const unsupported = wav.slice(); new DataView(unsupported.buffer).setUint16(20, 6, true);
  await expect(collectAudio(decodeAudioResponse(new Response(unsupported, { headers: { 'Content-Type': 'audio/wav' } })))).rejects.toThrow('encoding');
});
