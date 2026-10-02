import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { createBridgeServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const bridge = createBridgeServer({
    host: config.host,
    port: config.port,
    psk: config.devicePsk,
    logger,
  });

  const address = await bridge.listen();
  logger.info("bridge_started", { port: address.port });

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info("bridge_stopping", { signal });
    await bridge.close();
  };

  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown startup error";
  process.stderr.write(`${JSON.stringify({ level: "error", event: "startup_failed", message })}\n`);
  process.exitCode = 1;
});
