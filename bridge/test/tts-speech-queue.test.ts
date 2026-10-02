import { afterEach, expect, test, vi } from 'vitest';
import { SpeechQueue } from '../src/tts/speech-queue.js';
import type { Speaker } from '../src/tts/speaker.js';
import { TtsRouter } from '../src/tts/router.js';
import { FakeDevice, FakeTtsEngine } from './fixtures/tts/fakes.js';
import type { KanaConverter } from '../src/tts/types.js';
const queues: SpeechQueue[] = [];
afterEach(() => { for (const queue of queues.splice(0)) queue.dispose(); vi.useRealTimers(); });
async function flush(): Promise<void> { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function setup(kana: KanaConverter = { convert: async text => text }, options = {}) {
 const device = new FakeDevice();
 const queue = new SpeechQueue(device, new TtsRouter({ TTS_ENGINE: 'sanotts' }, kana, () => new FakeTtsEngine()), options);
 queues.push(queue);
 return { device, queue };
}
test('Speaker returns tickets immediately; two sentences and queued utterances await matching done', async () => {
 const { device, queue } = setup();
 const speaker: Speaker = queue;
 const states: boolean[] = [];
 queue.on('speaking', value => states.push(value));
 const a = speaker.say('こんにちは。今日もがんばろう。', { expression: 'happy' });
 const b = speaker.say('おやすみ。');
 expect(a.id).not.toBe(b.id);
 expect(a.estimatedSeconds).toBeCloseTo(2.25);
 await flush();
 expect(device.messages).toHaveLength(1);
 device.done(99); await flush();
 expect(device.messages).toHaveLength(1);
 device.done(1); await flush();
 expect(device.messages.at(-1)).toMatchObject({ type: 'speak.kana', seq: 2, kana: '今日もがんばろう。' });
 device.done(2); await a.done; await flush();
 expect(device.messages.at(-1)).toMatchObject({ seq: 3, kana: 'おやすみ。' });
 expect(states).toEqual([true]);
 device.done(3); await b.done; await flush();
 expect(states).toEqual([true, false]);
 expect(device.listenerCount('message')).toBe(0);
 expect(device.listenerCount('offline')).toBe(0);
});
test('interrupt cancels playback and queued tickets; ignores stale done', async () => {
 const { device, queue } = setup();
 const a = queue.say('一番です。');
 const b = queue.say('二番です。');
 await flush();
 const c = queue.say('新しい発話。', { interrupt: true });
 await expect(a.done).rejects.toThrow('interrupted');
 await expect(b.done).rejects.toThrow('interrupted');
 await flush();
 expect(device.messages.map(msg => msg.type)).toEqual(['speak.kana', 'tts.cancel', 'speak.kana']);
 device.done(1); await flush();
 let settled = false; void c.done.then(() => { settled = true; });
 await flush(); expect(settled).toBe(false);
 device.done(2); await c.done;
});
test('abort during synthesis advances even if converter ignores signal, without late send', async () => {
 let resolve!: (text: string) => void;
 const { device, queue } = setup({ convert: text => text.includes('遅い') ? new Promise(yes => { resolve = yes; }) : Promise.resolve('あ') });
 const a = queue.say('遅い発話。'); await flush();
 const b = queue.say('新しい発話。', { interrupt: true });
 await expect(a.done).rejects.toThrow(); await flush();
 resolve('おそい'); await flush();
 expect(device.messages.filter(msg => msg.type === 'speak.kana')).toHaveLength(1);
 device.done(1); await b.done;
});
test('500 Unicode characters clipped, warning metadata and timing log contain no text', async () => {
 const convert = vi.fn(async (text: string) => text ? 'あ' : '');
 const log = vi.fn();
 const { device, queue } = setup({ convert }, { maxChars: 900, log });
 device.autoDone = true;
 const ticket = queue.say('あ'.repeat(499) + '𠮷終');
 await ticket.done;
 expect(Array.from(convert.mock.calls[0][0])).toHaveLength(500);
 expect(ticket.estimatedSeconds).toBe(75);
 expect(log).toHaveBeenCalledWith('tts.truncated', { level: 'warn', originalChars: 501, maxChars: 500 });
 expect(log).toHaveBeenCalledWith('tts.sent', expect.objectContaining({ route: 'sanotts', conversionToSendMs: expect.any(Number) }));
 expect(JSON.stringify(log.mock.calls)).not.toContain('あ');
});
test('failed done cancels device, rejects ticket and advances queue', async () => {
 const { device, queue } = setup();
 const a = queue.say('失敗します。'); const b = queue.say('次です。'); await flush();
 device.done(1, false); await expect(a.done).rejects.toThrow('failed'); await flush();
 expect(device.messages.map(msg => msg.type)).toEqual(['speak.kana', 'tts.cancel', 'speak.kana']);
 device.done(2); await b.done;
});
test('timeout cleans listeners and cancels playback', async () => {
 vi.useFakeTimers();
 const { device, queue } = setup(undefined, { doneTimeoutMs: 10 });
 const ticket = queue.say('待ちます。'); await flush();
 await vi.advanceTimersByTimeAsync(10);
 await expect(ticket.done).rejects.toThrow('timed out');
 expect(device.listenerCount('message')).toBe(0);
 expect(device.messages.at(-1)?.type).toBe('tts.cancel');
});
test('offline during conversion/playback rejects without listener leaks', async () => {
 const { device, queue } = setup();
 const ticket = queue.say('切断します。'); await flush(); device.disconnect();
 await expect(ticket.done).rejects.toThrow('disconnected');
 expect(device.listenerCount('message')).toBe(0);
 const next = queue.say('再生できません。'); await expect(next.done).rejects.toThrow('offline');
});
test('synchronous device acknowledgement is not lost; PCM integration sends all bytes', async () => {
 const { device, queue } = setup(); device.autoDone = true;
 await queue.say('Hello!').done;
 expect(device.binaries.reduce((total, frame) => total + frame.data.length, 0)).toBe(10000);
 expect(device.listenerCount('message')).toBe(0);
});
test('empty text, cancellation and disposal settle all tickets', async () => {
 const { device, queue } = setup();
 await queue.say('✅').done; expect(device.messages).toHaveLength(0);
 const a = queue.say('再生します。'); const b = queue.say('待ちます。'); await flush();
 queue.cancelAll();
 await expect(a.done).rejects.toThrow(); await expect(b.done).rejects.toThrow();
 queue.dispose(); await expect(queue.say('終了。').done).rejects.toThrow('disposed');
});
