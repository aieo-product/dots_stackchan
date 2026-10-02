import type { DeviceCapabilities } from '../protocol.js';
export interface DeviceMessage {
  type: string;
  [key: string]: unknown;
}

/** A per-device adapter; the bridge core supplies this during integration. */
export interface DeviceLink {
  readonly online: boolean;
  readonly caps: DeviceCapabilities;
  send(message: DeviceMessage): void;
  sendBinary(kind: number, seq: number, data: Uint8Array): void;
  on(event: 'message' | 'offline', listener: (message?: DeviceMessage) => void): void;
  off(event: 'message' | 'offline', listener: (message?: DeviceMessage) => void): void;
}

export interface KanaConverter {
  convert(text: string, signal?: AbortSignal): Promise<string>;
}

export interface PcmAudio {
  data: Uint8Array;
  sampleRate: 16000;
}

export interface TtsEngine {
  synthesize(text: string, signal?: AbortSignal): Promise<PcmAudio>;
  /** 16kHz mono s16le. Consumers must close/abort abandoned streams. */
  stream?(text: string, signal?: AbortSignal): AsyncIterable<Uint8Array>;
  health?(signal?: AbortSignal): Promise<'ready' | 'unavailable' | 'unsupported'>;
  warmup?(): Promise<void>;
  dispose?(): Promise<void>;
}

/** Metadata only: implementations must never log text, credentials or errors from providers. */
export type TtsLog = (event: string, fields: Record<string, number | boolean | string>) => void;

export function abortError(): Error {
  return new DOMException('Speech interrupted', 'AbortError');
}

/** Also cancels waiting on third-party implementations that ignore the signal. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? abortError());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}
