#!/usr/bin/env node
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import process from "node:process";
import WebSocket from "ws";

function argument(name, fallback) {
  const position = process.argv.indexOf(`--${name}`);
  return position === -1 ? fallback : process.argv[position + 1];
}

const psk = argument("psk");
const deviceId = argument("id");
const url = argument("url", "ws://localhost:8790/device");
if (!psk || !deviceId) {
  process.stderr.write("Usage: node scripts/ws-client.mjs --psk <value> --id <device-id> [--url ws://localhost:8790/device]\n");
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
    caps: { sanotts: false, servo: false, mic: false },
  }));
});

socket.on("message", (data, isBinary) => {
  if (isBinary) {
    const frame = Buffer.from(data);
    const kind = frame[0];
    const seq = frame.byteLength >= 3 ? frame.readUInt16LE(1) : undefined;
    process.stdout.write(`${JSON.stringify({ binary: true, kind, seq, bytes: frame.byteLength })}\n`);
    return;
  }
  process.stdout.write(`${data.toString()}\n`);
});

socket.on("unexpected-response", (_request, response) => {
  process.stderr.write(`connection rejected with HTTP ${response.statusCode ?? "unknown"}\n`);
});

socket.on("error", (error) => {
  process.stderr.write(`websocket error: ${error.message}\n`);
});

socket.on("close", (code, reason) => {
  process.stdout.write(`closed code=${code} reason=${reason.toString()}\n`);
});
