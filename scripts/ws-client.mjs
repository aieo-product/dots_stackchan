#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import process from "node:process";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

function argument(name, fallback) {
  const position = process.argv.indexOf(`--${name}`);
  return position === -1 ? fallback : process.argv[position + 1];
}

const psk = argument("psk", process.env.DEVICE_PSK);
const deviceId = argument("id");
const url = argument("url", "ws://localhost:8790/device");
const wavPath = argument("wav");
const waitMs = Number(argument("wait-ms", "12000"));
if (!psk || !deviceId || (process.argv.includes("--wav") && !wavPath) || !Number.isFinite(waitMs) || waitMs < 0 || waitMs > 60000) {
  process.stderr.write("Usage: node scripts/ws-client.mjs --psk <value> --id <device-id> [--url ws://localhost:8790/device] [--wav <file>] [--wait-ms 12000] (DEVICE_PSK may replace --psk)\n");
  process.exit(2);
}

function readWav(file) {
  const wav = readFileSync(file);
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE" ||
      wav.readUInt32LE(4) + 8 !== wav.length) throw new Error("Invalid WAV container");
  let validFormat = false;
  let pcm;
  for (let offset = 12; offset < wav.length;) {
    if (offset + 8 > wav.length) throw new Error("Truncated WAV chunk");
    const kind = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size + (size % 2) > wav.length) throw new Error("Truncated WAV data");
    if (kind === "fmt ") {
      if (validFormat || size < 16 || wav.readUInt16LE(start) !== 1 || wav.readUInt16LE(start + 2) !== 1 ||
          wav.readUInt32LE(start + 4) !== 16000 || wav.readUInt32LE(start + 8) !== 32000 ||
          wav.readUInt16LE(start + 12) !== 2 || wav.readUInt16LE(start + 14) !== 16) {
        throw new Error("WAV must be 16 kHz mono PCM16");
      }
      validFormat = true;
    }
    if (kind === "data") {
      if (pcm !== undefined || size === 0 || size % 2 !== 0 || size > 480000) throw new Error("WAV must contain 0–15 seconds of aligned PCM16");
      pcm = wav.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }
  if (!validFormat || pcm === undefined) throw new Error("Missing WAV format or audio");
  return pcm;
}

let audio;
try { if (wavPath) audio = readWav(wavPath); } catch {
  process.stderr.write("WAV input rejected: use a non-empty 16 kHz mono PCM16 WAV, at most 15 seconds\n");
  process.exit(2);
}

const timestamp = String(Math.floor(Date.now() / 1_000));
const auth = createHmac("sha256", psk).update(`${deviceId}:${timestamp}`).digest("hex");
const socket = new WebSocket(url, {
  headers: {
    "X-Device-Id": deviceId,
    "X-Timestamp": timestamp,
    "X-Auth": auth,
  },
});

socket.on("open", () => {
  process.stdout.write("connected\n");
  socket.send(JSON.stringify({
    type: "hello",
    fw: "manual-client",
    caps: { sanotts: false, servo: false, mic: audio !== undefined },
  }));
});

let sending = false;
async function sendAudio(pcm) {
  const seq = 1;
  socket.send(JSON.stringify({ type: "mic.start", seq, sample_rate: 16000 }));
  let frames = 0;
  for (let offset = 0; offset < pcm.length; offset += 640) {
    if (socket.readyState !== WebSocket.OPEN) throw new Error("Device disconnected during WAV replay");
    const chunk = pcm.subarray(offset, offset + 640);
    const frame = Buffer.alloc(3 + chunk.length);
    frame[0] = 0x01;
    frame.writeUInt16LE(seq, 1);
    frame.set(chunk, 3);
    socket.send(frame, { binary: true });
    frames++;
    await delay(chunk.length / 32);
  }
  socket.send(JSON.stringify({ type: "mic.end", seq, reason: "release" }));
  process.stdout.write(`${JSON.stringify({ event: "audio_sent", frames, bytes: pcm.length, duration_ms: Math.round(pcm.length / 32) })}\n`);
  await delay(waitMs);
  socket.close(1000, "wav_complete");
}

socket.on("message", (data, isBinary) => {
  if (isBinary) {
    const frame = Buffer.from(data);
    const kind = frame[0];
    const seq = frame.byteLength >= 3 ? frame.readUInt16LE(1) : undefined;
    process.stdout.write(`${JSON.stringify({ binary: true, kind, seq, bytes: frame.byteLength })}\n`);
    return;
  }
  process.stdout.write(`${data.toString()}\n`);
  if (audio !== undefined && !sending) {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (message.type === "welcome") {
      sending = true;
      void sendAudio(audio).catch(() => {
        process.stderr.write("WAV replay failed\n");
        process.exitCode = 1;
        socket.close();
      });
    }
  }
});

socket.on("unexpected-response", (_request, response) => {
  process.exitCode = 1;
  response.destroy();
  process.stderr.write(`connection rejected with HTTP ${response.statusCode ?? "unknown"}\n`);
});

socket.on("error", (error) => {
  process.exitCode = 1;
  process.stderr.write(`websocket error: ${error.message}\n`);
});

socket.on("close", (code, reason) => {
  process.stdout.write(`closed code=${code} reason=${reason.toString()}\n`);
});
