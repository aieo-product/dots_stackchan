import { z } from "zod";

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
});

export interface BridgeConfig {
  devicePsk: string;
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
    port: result.data.BRIDGE_PORT,
    host: result.data.BRIDGE_HOST,
    logLevel: result.data.LOG_LEVEL,
  };
}
