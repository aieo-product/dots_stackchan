import { z } from 'zod';

/** Merge into the app's env schema; no env files are read by this module. */
export const ttsEnvSchema = z.object({
  KANA_ENGINE: z.enum(['wasm', 'python']).default('wasm'),
  TTS_ENGINE: z.enum(['sanotts', 'openai']).default('sanotts'),
  TTS_VOICE: z.string().trim().min(1).default('coral'),
  TTS_MAX_CHARS: z.coerce.number().int().min(1).max(500).default(500),
  TTS_INSTRUCTIONS: z.string().trim().min(1).default('Speak in a bright, cheerful and friendly tone.'),
});
export type TtsOptions = z.infer<typeof ttsEnvSchema>;
