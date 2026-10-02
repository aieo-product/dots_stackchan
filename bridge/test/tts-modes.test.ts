import { expect, test, vi } from 'vitest';
import { ttsEnvSchema } from '../src/tts/config.js';
import { TtsRouter } from '../src/tts/router.js';
import { createTtsRouter } from '../src/tts/create-router.js';
import { SpeechQueue } from '../src/tts/speech-queue.js';
import { FakeDevice, FakeTtsEngine } from './fixtures/tts/fakes.js';
import { startFakeLocalTts } from './fixtures/fake-local-tts.js';
import { startFakeVoicevox } from './fixtures/fake-voicevox.js';

test('mode defaults, legacy aliases, overrides, notification inheritance and URL requirements', () => {
  expect(ttsEnvSchema.parse({})).toMatchObject({ VOICE_MODE: 'device', TTS_ENGINE: 'openai', NOTIFY_TTS_ENGINE: 'openai' });
  expect(ttsEnvSchema.parse({ TTS_ENGINE: 'sanotts' })).toMatchObject({ VOICE_MODE: 'device', TTS_ENGINE: 'openai' });
  expect(ttsEnvSchema.parse({ TTS_ENGINE: 'openai' }).VOICE_MODE).toBe('bridge');
  expect(ttsEnvSchema.parse({ TTS_ENGINE: 'openai', VOICE_MODE: 'device' }).VOICE_MODE).toBe('device');
  expect(ttsEnvSchema.parse({ TTS_ENGINE: 'local-http', LOCAL_TTS_URL: 'http://localhost/tts' })).toMatchObject({ NOTIFY_TTS_ENGINE: 'local-http', LOCAL_TTS_TIMEOUT_MS: 30000 });
  expect(() => ttsEnvSchema.parse({ TTS_ENGINE: 'local-http' })).toThrow('LOCAL_TTS_URL');
  expect(() => ttsEnvSchema.parse({ NOTIFY_TTS_ENGINE: 'voicevox' })).toThrow('VOICEVOX_URL');
});
test('bridge mode sends every language as PCM; device Japanese skips HTTP; fallback and display', async () => {
  const device = new FakeDevice(); const engine = new FakeTtsEngine(320);
  const factory = vi.fn(() => engine); const convert = vi.fn(async () => 'あ');
  for (const mode of ['device', 'bridge'] as const) {
    const router = new TtsRouter({ TTS_ENGINE: 'openai', VOICE_MODE: mode }, { convert }, factory);
    router.announceMode(device);
    expect(device.messages.at(-1)).toMatchObject({ type: 'voice.mode', mode });
    for (const text of ['こんにちは。', 'Hello!', '你好。', '안녕!']) {
      const payload = await router.prepare(text, device, new AbortController().signal);
      expect(payload.route).toBe(mode === 'device' && text === 'こんにちは。' ? 'sanotts' : 'openai');
    }
  }
  const router = new TtsRouter({ TTS_ENGINE: 'openai', VOICE_MODE: 'device' }, { convert }, factory);
  device.caps.sanotts = false; router.announceMode(device);
  expect(device.messages.at(-1)).toMatchObject({ type: 'voice.mode', mode: 'bridge' });
  expect((await router.prepare('こんにちは。', device, new AbortController().signal)).route).toBe('openai');
  expect(convert).toHaveBeenCalledTimes(1);
});
test('notifications use separate engine with same Speaker contract; lazy local health', async () => {
  const server = await startFakeLocalTts();
  const device = new FakeDevice(); device.autoDone = true;
  const options = ttsEnvSchema.parse({ VOICE_MODE: 'bridge', TTS_ENGINE: 'openai', NOTIFY_TTS_ENGINE: 'local-http', LOCAL_TTS_URL: `${server.url}/tts` });
  const router = createTtsRouter(options, { convert: async () => { throw new Error('unexpected kana'); } });
  const queue = new SpeechQueue(device, router);
  try {
    expect(await router.health('notification')).toBe('ready');
    expect(await router.health()).toBe('unavailable');
    await queue.say('通知です。', { purpose: 'notification' }).done;
    expect(server.requests[0]?.body.text).toBe('通知です。');
    expect(device.messages.find(msg => msg.type === 'tts.start')).toMatchObject({ engine: 'local-http', voice_mode: 'bridge' });
  } finally { queue.dispose(); await server.close(); }
});

test.each(['local-http', 'voicevox'] as const)('%s requests next sentence before active playback finishes', async engine => {
  const server = engine === 'local-http' ? await startFakeLocalTts() : await startFakeVoicevox();
  const device = new FakeDevice();
  const options = ttsEnvSchema.parse({ VOICE_MODE: 'bridge', TTS_ENGINE: engine,
    LOCAL_TTS_URL: `${server.url}/tts`, VOICEVOX_URL: server.url });
  const queue = new SpeechQueue(device, createTtsRouter(options, { convert: async () => '' }));
  try {
    const ticket = queue.say('こんにちは。今日もがんばろう。');
    await vi.waitFor(() => expect(device.messages.at(-1)).toMatchObject({ type: 'tts.end', seq: 1 }));
    await vi.waitFor(() => expect(server.requests).toHaveLength(engine === 'local-http' ? 2 : 4));
    expect(device.messages.filter(message => message.type === 'tts.start')).toHaveLength(1);
    device.done(1);
    await vi.waitFor(() => expect(device.messages.at(-1)).toMatchObject({ type: 'tts.end', seq: 2 }));
    device.done(2); await ticket.done;
    expect(device.binaries.reduce((total, frame) => total + frame.data.length, 0)).toBe(6400);
  } finally { queue.dispose(); await server.close(); }
});
