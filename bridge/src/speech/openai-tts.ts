import type { VoiceConfig } from "./config.js";

export type PcmSource = (text: string, signal: AbortSignal) => AsyncIterable<Uint8Array>;

export function openAiPcmSource(config: VoiceConfig, apiKey: string,
  fetcher: typeof fetch = fetch): PcmSource {
  return async function* (text, signal) {
    if (!apiKey || apiKey.startsWith("keychain://")) {
      throw new Error("Inject OPENAI_API_KEY into the child process with akc run");
    }
    const response = await fetcher("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: config.voice,
        instructions: config.instructions, input: text, response_format: "pcm", stream_format: "audio" }),
    });
    // Never include the provider body, request text or key in diagnostics.
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`OpenAI TTS HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    try {
      while (true) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        yield chunk.value;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  };
}
