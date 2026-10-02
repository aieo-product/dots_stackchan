import { startApp } from "./app/app.js";

async function main(): Promise<void> {
  const app = await startApp();
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    await app.close().catch(() => {
      process.stderr.write('{"level":"error","event":"shutdown_failed"}\n');
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

main().catch((error: unknown) => {
  // Provider and filesystem errors can contain private URLs, paths or credentials.
  const message = error instanceof Error && error.message.startsWith("Invalid application configuration:")
    ? error.message : "Application startup failed; check listeners, private stores and speech engine setup.";
  process.stderr.write(`${JSON.stringify({ level: "error", event: "startup_failed", message })}\n`);
  process.exitCode = 1;
});
