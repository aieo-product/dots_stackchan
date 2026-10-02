export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

type LogSink = (line: string) => void;

const levelPriority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const sensitiveKey = /(?:auth|device.?id|host|hostname|ip|psk|secret|token)/i;
const ipv4Pattern = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

export function redactLogValue(key: string, value: unknown): unknown {
  if (sensitiveKey.test(key)) return "<redacted>";
  if (typeof value === "string") return value.replace(ipv4Pattern, "<redacted:ip>");
  if (Array.isArray(value)) return value.map((item) => redactLogValue("item", item));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([nestedKey, nestedValue]) => [nestedKey, redactLogValue(nestedKey, nestedValue)]),
    );
  }
  return value;
}

export function createLogger(minimumLevel: LogLevel = "info", sink: LogSink = console.log): Logger {
  const write = (level: LogLevel, event: string, fields: LogFields = {}): void => {
    if (levelPriority[level] < levelPriority[minimumLevel]) return;
    const safeFields = Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, redactLogValue(key, value)]),
    );
    sink(JSON.stringify({ level, event, ...safeFields }));
  };

  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}
