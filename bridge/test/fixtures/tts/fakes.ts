import { EventEmitter } from 'node:events';
import type { DeviceLink, DeviceMessage, PcmAudio, TtsEngine } from '../../../src/tts/types.js';
export class FakeDevice extends EventEmitter implements DeviceLink {
 online = true;
 caps = { sanotts: true, servo: true, mic: true };
 messages: DeviceMessage[] = [];
 binaries: { kind: number; seq: number; data: Uint8Array }[] = [];
 autoDone = false;
 send(message: DeviceMessage): void {
  this.messages.push(message);
  if (this.autoDone && ['speak.kana', 'tts.end'].includes(message.type)) this.done(Number(message.seq));
 }
 sendBinary(kind: number, seq: number, data: Uint8Array): void { this.binaries.push({ kind, seq, data: data.slice() }); }
 done(seq: number, ok = true): void { this.emit('message', { type: 'tts.done', seq, ok }); }
 disconnect(): void { this.online = false; this.emit('offline'); }
}
export class FakeTtsEngine implements TtsEngine {
 readonly texts: string[] = [];
 constructor(private readonly bytes = 10000) {}
 async synthesize(text: string): Promise<PcmAudio> {
  this.texts.push(text);
  return { data: new Uint8Array(this.bytes), sampleRate: 16000 };
 }
}
