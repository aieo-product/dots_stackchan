# Device protocol v1

This document is the contract between the bridge and device firmware. “Device” is abbreviated as D and “bridge” as B.

## Connection and authentication

Connect to `ws(s)://<bridge>:<port>/device` with these HTTP upgrade headers:

| Header | Value |
|---|---|
| `X-Device-Id` | Device identifier |
| `X-Timestamp` | Current Unix time in seconds |
| `X-Auth` | Lowercase or uppercase hex encoding of `HMAC-SHA256(psk, "${deviceId}:${timestamp}")` |

The bridge returns HTTP 401 when the timestamp differs from bridge time by more than 60 seconds, the HMAC is wrong, a header is absent, or the same `(deviceId, timestamp, auth)` tuple is reused. After a successful WebSocket connection, the device sends D→B `hello`; the bridge responds with `welcome`.

Production deployments should expose this endpoint as WSS through a TLS terminator. The bridge itself also supports plain WS for a trusted local network and tests.

## JSON text frames

Every text frame is one JSON object. Fields shown below are top-level fields alongside `type`; additional fields are rejected.

| Direction | `type` | Payload fields |
|---|---|---|
| D→B | `hello` | `{fw: string, caps: {sanotts: bool, servo: bool, mic: bool}}` |
| B→D | `welcome` | `{session: string, server_time: integer}`; time is Unix seconds |
| D→B | `state` | `{state: "idle" \| "listening" \| "thinking" \| "speaking" \| "notifying"}` |
| D→B | `event` | `{kind: "touch" \| "button", where?: string}` |
| D→B | `mic.start` | `{seq: u16, sample_rate: 16000}` |
| D→B | `mic.end` | `{seq: u16, reason: "release" \| "timeout" \| "vad"}` |
| B→D | `face` | `{expression: "neutral" \| "happy" \| "sad" \| "doubt" \| "sleepy" \| "angry"}` |
| B→D | `look` | `{pan: number, tilt: number}`; degrees, device clamps pan to −90…90 and tilt to −30…30 |
| B→D | `speak.kana` | `{seq: u16, kana: string, expression?: face expression}` |
| B→D | `tts.start` | `{seq: u16, sample_rate: positive integer, channels: 1, bits: 16}` |
| B→D | `tts.end` | `{seq: u16}` |
| B→D | `tts.cancel` | No fields |
| D→B | `tts.done` | `{seq: u16, ok: bool}` |
| B→D | `chime` | `{kind: "notify"}` |
| Both | `ping` / `pong` | `{t: number}` |

`seq` correlates start/end messages and their binary frames. The device synthesizes and plays `speak.kana` with sanoTTS. For bridge-generated audio, the bridge sends `tts.start`, zero or more TTS PCM binary frames, and `tts.end`. `tts.cancel` stops synthesis or playback in progress.

## Binary frames

Each binary WebSocket frame is at most 4096 bytes, including this three-byte header:

| Offset | Size | Field |
|---:|---:|---|
| 0 | 1 byte | `kind` (`0x01` microphone PCM, `0x02` TTS PCM) |
| 1 | 2 bytes | `seq`, unsigned 16-bit little-endian |
| 3 | remainder | PCM bytes |

Microphone PCM (`0x01`) travels D→B and is 16 kHz, signed 16-bit, mono. TTS PCM (`0x02`) travels B→D; its format comes from the preceding `tts.start`. A binary frame with the wrong direction, an unknown kind, a missing header, or more than 4096 total bytes is invalid.

## Liveness and reconnects

The bridge uses WebSocket control-frame ping/pong heartbeats and drops a connection that misses a heartbeat. Protocol-level `ping` receives a `pong` with the same `t` value. On disconnect the device becomes offline; a later authenticated connection with the same device ID replaces that state with online and receives a new session ID.
