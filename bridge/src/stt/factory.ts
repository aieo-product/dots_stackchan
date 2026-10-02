import type { BridgeConfig } from "../config.js";
import type { Logger } from "../log.js";
import { FakeStt, type SttEngine } from "./engine.js";
import { FallbackStt } from "./fallback.js";
import { OpenAiBatch } from "./openai-batch.js";
import { LocalSttEngine } from "./local.js";
import { MlxWhisperBackend } from "./mlx-whisper.js";
import { WhisperCppBackend } from "./whisper-cpp.js";
import { OpenAiRealtime } from "./openai-realtime.js";

export function createSttEngineFactory(config: BridgeConfig, logger: Logger): () => SttEngine {
  if (config.sttEngine === "fake") return () => new FakeStt({ text: "こんにちは、スタックちゃん", lang: config.sttLanguage });
  if (config.sttEngine === "local") return () => new LocalSttEngine(
    config.sttLocalBackend === "mlx-whisper"
      ? new MlxWhisperBackend({ model: config.sttModel, python: config.sttLocalPython })
      : new WhisperCppBackend({ url: config.sttLocalUrl }), config.sttLanguage);
  const apiKey = config.openaiApiKey;
  if (apiKey === undefined || apiKey.startsWith("keychain://")) {
    throw new Error("OPENAI_API_KEY must be injected into the bridge process");
  }
  return () => {
    const batch = new OpenAiBatch({ apiKey, language: config.sttLanguage,
      ...(config.sttEngine === "openai-batch" ? { model: config.sttModel } : { model: config.sttBatchModel }),
    });
    if (config.sttEngine === "openai-batch") return batch;
    return new FallbackStt(new OpenAiRealtime({ apiKey, model: config.sttModel, language: config.sttLanguage }), batch,
      () => logger.warn("stt_fallback", { engine: "openai-batch" }));
  };
}
