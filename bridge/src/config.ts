import { z } from "zod";
import { DEFAULT_BATCH_MODEL } from "./stt/openai-batch.js";
import { DEFAULT_LOCAL_MODEL } from "./stt/local.js";
import { DEFAULT_REALTIME_MODEL } from "./stt/openai-realtime.js";

const portSchema = z.preprocess(
  (value) => (value === undefined || value === "" ? 8790 : value),
  z.coerce.number().int().min(1).max(65_535),
);

const hostSchema = z.preprocess(
  (value) => (value === undefined || value === "" ? "0.0.0.0" : value),
  z.string().min(1),
);

const logLevelSchema = z.preprocess(
  (value) => (value === undefined || value === "" ? "info" : value),
  z.enum(["debug", "info", "warn", "error"]),
);

const environmentSchema = z.object({
  DEVICE_PSK: z.string().min(1, "DEVICE_PSK is required"),
  BRIDGE_PORT: portSchema,
  BRIDGE_HOST: hostSchema,
  LOG_LEVEL: logLevelSchema,
  STT_ENGINE: z.enum(["openai-realtime", "openai-batch", "local", "fake"]).default("openai-realtime"),
  STT_MODEL: z.string().min(1).optional(),
  STT_LOCAL_BACKEND: z.enum(["mlx-whisper", "whisper-cpp"]).default(
    process.platform === "darwin" && process.arch === "arm64" ? "mlx-whisper" : "whisper-cpp"),
  STT_LOCAL_URL: z.url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol))
    .default("http://localhost:8080/inference"),
  STT_LOCAL_PYTHON: z.string().min(1).default("python3"),
  STT_BATCH_MODEL: z.string().min(1).default(DEFAULT_BATCH_MODEL),
  STT_LANGUAGE: z.string().regex(/^[a-z]{2,3}(?:-[a-z]{2,4})?$/).default("ja"),
  LOG_TRANSCRIPTS: z.enum(["true", "false"]).default("false"),
  OPENAI_API_KEY: z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional()),
});

export interface BridgeConfig {
  devicePsk: string;
  sttEngine: "openai-realtime" | "openai-batch" | "local" | "fake";
  sttLocalBackend: "mlx-whisper" | "whisper-cpp";
  sttLocalUrl: string;
  sttLocalPython: string;
  sttModel: string;
  sttBatchModel: string;
  sttLanguage: string;
  logTranscripts: boolean;
  openaiApiKey?: string;
  port: number;
  host: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const result = environmentSchema.safeParse(environment);
  if (!result.success) {
    const keys = [...new Set(result.error.issues.map((issue) => String(issue.path[0] ?? "environment")))];
    throw new Error(`Invalid bridge configuration: ${keys.join(", ")}`);
  }

  return {
    devicePsk: result.data.DEVICE_PSK,
    sttEngine: result.data.STT_ENGINE,
    sttModel: result.data.STT_MODEL ?? (result.data.STT_ENGINE === "local" ? DEFAULT_LOCAL_MODEL
      : result.data.STT_ENGINE === "openai-batch" ? DEFAULT_BATCH_MODEL : DEFAULT_REALTIME_MODEL),
    sttLocalBackend: result.data.STT_LOCAL_BACKEND,
    sttLocalUrl: result.data.STT_LOCAL_URL,
    sttLocalPython: result.data.STT_LOCAL_PYTHON,
    sttBatchModel: result.data.STT_BATCH_MODEL,
    sttLanguage: result.data.STT_LANGUAGE,
    logTranscripts: result.data.LOG_TRANSCRIPTS === "true",
    openaiApiKey: result.data.OPENAI_API_KEY,
    port: result.data.BRIDGE_PORT,
    host: result.data.BRIDGE_HOST,
    logLevel: result.data.LOG_LEVEL,
  };
}
