import type { TtsOptions } from './config.js';
import { OpenJtalkKanaConverter } from './kana.js';
import { PythonOpenJtalkSidecar } from './sidecar.js';
import { WasmKanaConverter } from './wasm.js';
import type { KanaConverter } from './types.js';

/** Integration calls this once at startup, and dispose() at shutdown. */
export async function createKanaConverter(options: Pick<TtsOptions, 'KANA_ENGINE'>): Promise<KanaConverter & { dispose(): void }> {
  if (options.KANA_ENGINE === 'wasm') return WasmKanaConverter.create();
  const sidecar = new PythonOpenJtalkSidecar();
  await sidecar.start();
  const converter = new OpenJtalkKanaConverter(sidecar);
  return { convert: (text, signal) => converter.convert(text, signal), dispose: () => sidecar.dispose() };
}
