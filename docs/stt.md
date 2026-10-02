# Bridge speech recognition

The bridge accepts protocol v1 `mic.start` → microphone binary frames → `mic.end`
from authenticated devices. Input is signed little-endian PCM16, 16 kHz, mono.
Every binary frame carries the **same utterance `seq`** as start/end; it is not a
packet counter. WebSocket preserves frame order. The bridge emits one final
`DeviceHub` event per successfully transcribed turn:

```ts
hub.on("utterance", ({ deviceId, payload }) => {
  // payload: { seq, text, lang, duration_ms, latency_ms }
  // Deliver payload.text to the conversation layer here.
});
hub.on("stt.partial", ({ deviceId, payload }) => {
  // payload: { seq, delta }; optional incremental display, not a final utterance.
});
```

These are in-process events, not new device protocol messages. A downstream Dot
consumer can subscribe to `utterance`. `duration_ms` comes from accepted PCM byte
count; `latency_ms` measures from receipt of matching `mic.end` (or automatic
cutoff) until the final transcript. The target is **≤600 ms** for warm streaming;
this is a measurement target, not a guaranteed API service time. Batch fallback
is expected to take longer.

## Current OpenAI method

Checked against official OpenAI documentation on **2026-10-02**:

- [Realtime transcription](https://developers.openai.com/api/docs/guides/realtime-transcription)
  recommends **`gpt-live-transcribe`** for live input. It emits deltas while audio
  arrives, with a final transcript on `input_audio_buffer.commit`.
- [File transcription](https://developers.openai.com/api/docs/guides/speech-to-text)
  recommends **`gpt-transcribe`** for completed audio, used for fallback here.

The bridge opens a server-side Realtime WebSocket when the device connects and
reuses it across turns to avoid a handshake after release. It sends
`session.update` with `session.type="transcription"`, PCM at 24 kHz,
`audio.input.transcription.languages=[STT_LANGUAGE]`, `delay="low"`, a
`スタックちゃん` vocabulary hint, and `turn_detection=null`. Push-to-talk controls
commit explicitly. `prepare()` resolves after `session.updated`, and the hub emits
`stt.ready` once setup succeeds. Applications and latency tests can wait for this
event before `mic.start`; a device that starts earlier still uses a bounded setup
buffer. Setup failure emits no readiness event and leaves batch fallback available. The model does not support server VAD. The device's 16 kHz
input is linearly resampled to 24 kHz with interpolation phase preserved across
frames. Raw PCM, not a WAV header, is base64 encoded in
`input_audio_buffer.append`. Final results are correlated by `item_id` with
`input_audio_buffer.committed`.

A lost connection, failed setup, upstream error, backpressure, or a 2-second final
result timeout triggers one batch attempt with all accepted PCM from that turn.
Batch builds a WAV and multipart upload entirely in memory. For the default batch
model it sends plural `languages[]` and `keywords[]` hints; configurable legacy
models use singular `language` and `prompt`. Likewise, legacy Realtime models use
singular `language`. Models that only transcribe committed turns can be selected,
but do not provide the default model's incremental recognition during speech.
Setup has a 3-second deadline; batch requests have an 8-second deadline. Cancelled
turns use a new Realtime connection so late results cannot become the next turn.
There is no background retry loop. A subsequent turn reconnects if necessary.

## Configuration and secrets

| Environment variable | Default | Meaning |
|---|---|---|
| `STT_ENGINE` | `openai-realtime` | `openai-realtime`, `openai-batch`, or `fake` |
| `STT_MODEL` | `gpt-live-transcribe` | Primary model; defaults to `gpt-transcribe` in batch mode |
| `STT_BATCH_MODEL` | `gpt-transcribe` | Fallback model, independently configurable |
| `STT_LANGUAGE` | `ja` | Expected language code; also emitted as `lang` |
| `LOG_TRANSCRIPTS` | `false` | Explicit `true` includes final text in local bridge logs |
| `OPENAI_API_KEY` | unset | Required for OpenAI engines; inject from Keychain |

Never put real keys in source, `.env`, command arguments, or committed files.
Start an API-backed bridge with Keychain references resolved in its child process:

```sh
export DEVICE_PSK=keychain://DEVICE_PSK
export OPENAI_API_KEY=keychain://OPENAI_API_KEY
akc run -- npm run start --workspace bridge
```

Unresolved `keychain://` API references are rejected at startup. `fake` requires
no OpenAI key and always returns a deterministic synthetic result; it does not
recognize speech. The `SttEngine` interface (`prepare`, `start(seq)`, `push(pcm)`,
`end`, `cancel`, `close`, `partial` events) allows another provider to be added.
`STT_ENGINE=local` is deliberately not implemented pending the user's decision.
Embedding applications may inject their own factory via `createBridgeServer`'s
`stt.createEngine` option. The bridge executable always wires STT; a server
constructed without that option remains a transport-only gateway.

## Limits and privacy

Each connected device owns at most one recording or pending transcription.
Overlapping starts are rejected. Data/end outside a turn and repeated ends are
ignored. PCM with a mismatched sequence, zero bytes, or incomplete 16-bit samples
cancels the turn. A stale end sequence is ignored without ending the current
recording. The protocol already rejects invalid binary kinds and oversized frames.

Recording ends automatically at **15 seconds of wall time or 480,000 PCM bytes**,
whichever comes first. A frame crossing the byte limit is trimmed on a sample
boundary, and subsequent frames are ignored. **2 seconds** without PCM cancels an
unfinished recording; empty recordings do not call STT. Final transcription has a
**12-second** overall deadline. Disconnect, replacement connection, and bridge
shutdown cancel processing and suppress late results. One bounded buffer is
retained for fallback (480,000 bytes); another of the same capacity is used only
while Realtime setup is pending. Conversion and upload create bounded temporary
copies. There is no unbounded queue of recordings or individual audio frames.

Audio is **never saved to disk** by the bridge; there is no audio debug-save flag.
Committed synthetic test fixtures are the only intentional stored speech here.
OpenAI engines send audio to OpenAI, so in-memory local handling does not imply
local recognition. Default logs contain sequence, language, duration, latency,
and character count, but no transcript or partial text. Provider errors use
fixed messages without response bodies or credentials. `LOG_TRANSCRIPTS=true` is
an explicit opt-in; do not publish those logs. Events intentionally contain text
for the application consumer.

The bridge rejects starts when device state reports `speaking` or `notifying`.
Firmware push-to-talk, actual microphone recording, and suppression during
TTS/sanoTTS/chimes are a separate follow-up after #5. This state guard alone
cannot establish hardware-level playback suppression.

## WAV replay and tests

Run a bridge in one terminal (inject the existing device PSK):

```sh
export DEVICE_PSK=keychain://DEVICE_PSK
STT_ENGINE=fake akc run -- npm run start --workspace bridge
```

Replay the synthetic fixture in another terminal:

```sh
export DEVICE_PSK=keychain://DEVICE_PSK
akc run -- node scripts/ws-client.mjs --id test-device \
  --url 'ws://localhost:8790/device' --wav bridge/test/fixtures/hello_ja.wav
```

For a remote TLS bridge, use `wss://<your-host>/device`. The client waits for
`welcome`, sends 640-byte/20-ms PCM chunks (last chunk may be shorter), and ends
with reason `release`. It waits 12 seconds for bridge processing before closing;
`--wait-ms` overrides this (0–60000). It reports bytes/frame count without
transcripts. Observe the bridge's redacted `utterance` log or subscribe to the hub
in-process. A successful client replay alone does not prove recognition succeeded.
The client rejects non-PCM16, non-mono, non-16-kHz, empty, truncated, and >15-second
WAV input before connecting.

```sh
npm run check
# Only when OPENAI_API_KEY is injected: paid, synthetic-audio API integration tests.
export OPENAI_API_KEY=keychain://OPENAI_API_KEY
akc run -- npx vitest run bridge/test/stt-integration.test.ts
```

CI has no API key. Real OpenAI tests automatically skip unless `OPENAI_API_KEY` is
set. They exercise both streaming with fallback and direct batch via an authenticated
fake device, wait for `stt.ready` before recording, and replay 640-byte frames at
20-ms intervals. Three turns reuse the same prepared connection. They require `スタックちゃん` in the final result, and report only
numeric preparation/replay/duration/latency timings, keyword accuracy, and whether
the 600-ms target was met. Realtime must report zero batch fallbacks; the test
fails if it measures fallback instead of the requested streaming backend. They do not enforce
that target as a stable network-dependent unit assertion. Streaming fallback is
logged as `stt_fallback`; a fallback success does not establish Realtime latency.
Unit tests simulate provider responses/errors, timeout, cancellation, result
correlation, resampling, WAV creation, ordering, duration/memory bounds, and log
privacy. Keyless integration uses a fake engine and the actual authenticated
WebSocket/CLI to prove delivery and event emission, not recognition accuracy.

## Synthetic fixture provenance

`bridge/test/fixtures/hello_ja.wav` was generated on 2026-10-02 by the macOS
built-in `say` Japanese **Kyoko** synthetic voice, saying
`こんにちは、スタックちゃん`. It is not a human recording and does not use sanoTTS.
The AIFF intermediate was converted with FFmpeg and removed. Reproduction on a
Mac with that voice installed:

```sh
say -v Kyoko -o bridge/test/fixtures/hello_ja.aiff 'こんにちは、スタックちゃん'
ffmpeg -y -hide_banner -loglevel error \
  -i bridge/test/fixtures/hello_ja.aiff -ac 1 -ar 16000 -c:a pcm_s16le \
  -map_metadata -1 -fflags +bitexact -flags:a +bitexact \
  bridge/test/fixtures/hello_ja.wav
rm bridge/test/fixtures/hello_ja.aiff
```

Current fixture: **58,594 bytes** including the 44-byte WAV header;
**58,550 PCM bytes**, **1.8296875 seconds**, **92** replay frames. Voice/OS versions
can change synthesis duration, so regenerate expected integration counts if the
fixture is replaced. Tests check that the file contains non-empty PCM speech.
No source path, personal metadata, or real speaker identity is embedded.

Hardware acceptance still needs K151 push-to-talk and playback-suppression checks,
synthetic speech played into its microphone, warm API latency measurement, and
redacted bridge logs plus a photo of the recording indicator. Do not attach human
voice recordings.

## Realtime latency follow-up

The reviewer measured this 1.83-second fixture before the readiness follow-up:

| Engine | Before: end → final text | After: end → final text |
|---|---:|---:|
| `openai-realtime` | 1,798 ms | Pending reviewer rerun with a real key |
| `openai-batch` | 851 ms | Pending reviewer rerun with a real key |

Neither baseline met 600 ms. A slow streaming result alone does not identify a
service-side cause. Inspection found that preconnection existed but setup was
not awaited by the measurement. The WAV CLI already paced audio at 20 ms and the
engine already sent commit synchronously from `end()` on a ready socket. This
follow-up makes completed preparation awaitable, disables WebSocket compression,
and tests those properties explicitly. The integration test now waits for the
server's `session.updated`, streams throughout speech, commits at release, and
prints per-turn JSON plus a table. `latency_ms` starts when the bridge receives
`mic.end`; `device_end_to_text_ms` also includes local WebSocket delivery. Setup
and the 1.83 seconds of speech are excluded from both end-to-text measurements.
There is no OpenAI key in this implementation session, so no after result or
claim of reaching 600 ms is fabricated. Rerun the key-gated command above to fill
in the after measurements; compare all three warm turns and report model choice.
