export type VoiceMode = "device" | "bridge";
export interface VoiceConfig {
  mode?: VoiceMode;
  voice: string;
  instructions?: string;
}

const voices = new Set(["alloy", "ash", "ballad", "coral", "echo", "fable",
  "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"]);

export function readVoiceConfig(env: NodeJS.ProcessEnv = process.env): VoiceConfig {
  const mode = env.VOICE_MODE || undefined;
  if (mode !== undefined && mode !== "device" && mode !== "bridge") {
    throw new Error("VOICE_MODE must be device or bridge");
  }
  const voice = env.TTS_VOICE || "coral";
  if (!voices.has(voice)) throw new Error("TTS_VOICE must be a supported OpenAI voice");
  return { mode, voice, instructions: env.TTS_INSTRUCTIONS || undefined };
}

export function selectVoiceMode(config: VoiceConfig, sanotts: boolean, language: string): VoiceMode {
  if (config.mode === "bridge") return "bridge";
  if (config.mode === "device") {
    if (!sanotts || !/^ja(?:-|$)/i.test(language)) {
      throw new Error("Device voice requires Japanese and caps.sanotts; use VOICE_MODE=bridge");
    }
    return "device";
  }
  return sanotts && /^ja(?:-|$)/i.test(language) ? "device" : "bridge";
}
