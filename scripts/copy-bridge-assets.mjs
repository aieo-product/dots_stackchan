import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { URL } from "node:url";

const output = resolve(process.argv[2] ?? "dist");
for (const asset of ["stt/mlx-worker.py", "tts/openjtalk-sidecar.py", "tts/mora-table.json", "tts/LICENSE-sanotts"]) {
  const destination = resolve(output, asset);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(new URL(`../bridge/src/${asset}`, import.meta.url), destination);
}
