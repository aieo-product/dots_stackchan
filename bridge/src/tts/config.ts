import { z } from 'zod';

/** Merge into the app's env schema; no env files are read by this module. */
export const ttsEnvSchema = z.object({
  KANA_ENGINE: z.enum(['wasm', 'python']).default('wasm'),
  VOICE_MODE: z.enum(['device', 'bridge']).optional(),
  TTS_ENGINE: z.enum(['sanotts', 'openai', 'voicevox', 'local-http']).optional(),
  NOTIFY_TTS_ENGINE: z.enum(['openai', 'voicevox', 'local-http']).optional(),
  TTS_VOICE: z.string().trim().min(1).default('coral'),
  TTS_MODEL: z.enum(['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd']).default('gpt-4o-mini-tts'),
  TTS_MAX_CHARS: z.coerce.number().int().min(1).max(500).default(500),
  TTS_INSTRUCTIONS: z.string().trim().default('Speak in a bright, cheerful and friendly tone.'),
  VOICEVOX_URL: z.string().url().optional(),
  VOICEVOX_SPEAKER: z.coerce.number().int().nonnegative().default(0),
  LOCAL_TTS_URL: z.string().url().optional(),
  LOCAL_TTS_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  LOCAL_TTS_VOICE: z.string().optional(),
  LOCAL_TTS_STYLE: z.string().optional(),
  LOCAL_TTS_SEED: z.coerce.number().int().optional(),
  LOCAL_TTS_SPEED: z.coerce.number().positive().optional(),
}).transform(options => ({ ...options,
  // Preserve explicit pre-VOICE_MODE configurations; an unset config prefers device.
  VOICE_MODE: options.VOICE_MODE ?? (options.TTS_ENGINE && options.TTS_ENGINE !== 'sanotts' ? 'bridge' : 'device'),
  TTS_ENGINE: options.TTS_ENGINE === 'sanotts' ? 'openai' : options.TTS_ENGINE ?? 'openai',
  NOTIFY_TTS_ENGINE: options.NOTIFY_TTS_ENGINE ?? (options.TTS_ENGINE === 'sanotts' ? 'openai' : options.TTS_ENGINE ?? 'openai'),
})).superRefine((options, ctx) => {
  for (const engine of [options.TTS_ENGINE, options.NOTIFY_TTS_ENGINE]) {
    if (engine === 'local-http' && !options.LOCAL_TTS_URL) ctx.addIssue({ code: 'custom', path: ['LOCAL_TTS_URL'], message: 'LOCAL_TTS_URL is required for local-http' });
    if (engine === 'voicevox' && !options.VOICEVOX_URL) ctx.addIssue({ code: 'custom', path: ['VOICEVOX_URL'], message: 'VOICEVOX_URL is required for voicevox' });
  }
});
export type TtsOptions = z.infer<typeof ttsEnvSchema>;
