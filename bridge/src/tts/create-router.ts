import type { TtsOptions } from './config.js';
import type { KanaConverter, TtsEngine, TtsLog } from './types.js';
import { TtsRouter, type PcmEngineName } from './router.js';
import { OpenAiTtsEngine } from './openai.js';
import { LocalHttpTtsEngine } from './local-http.js';
import { VoicevoxTtsEngine } from './voicevox.js';

/** Secrets are injected by the caller and never logged or stored in config files. */
export function createTtsRouter(options: TtsOptions, kana: KanaConverter,
  secrets: { openaiApiKey?: string; localTtsToken?: string } = {}, log?: TtsLog): TtsRouter {
  const engines = new Map<PcmEngineName, TtsEngine>();
  return new TtsRouter(options, kana, name => {
    let engine = engines.get(name);
    if (!engine) {
      if (name === 'openai') engine = OpenAiTtsEngine.create(options, secrets.openaiApiKey, { log });
      else if (name === 'voicevox') engine = new VoicevoxTtsEngine(options.VOICEVOX_URL ?? '', options.VOICEVOX_SPEAKER);
      else engine = new LocalHttpTtsEngine({ url: options.LOCAL_TTS_URL ?? '', token: secrets.localTtsToken,
        voice: options.LOCAL_TTS_VOICE, style: options.LOCAL_TTS_STYLE,
        seed: options.LOCAL_TTS_SEED, speed: options.LOCAL_TTS_SPEED, timeoutMs: options.LOCAL_TTS_TIMEOUT_MS });
      engines.set(name, engine);
    }
    return engine;
  });
}
