# Privacy & secrets policy

This repository is public. Everything in code, commits, issues, PR comments, and test evidence
(screenshots, logs, recordings) must be free of personal information.

## Never include

| Category | Examples | Use instead |
|---|---|---|
| Network identifiers | tailnet name (`*.ts.net`), LAN/Tailscale IPs, Wi-Fi SSIDs, MAC addresses | `<your-host>.<your-tailnet>.ts.net`, `192.0.2.x` (RFC 5737), `<SSID>` |
| Accounts | e-mail addresses, real names, Slack workspace/channel IDs, ChatGPT account/workspace names | `<you@example.com>`, `<channel-id>` |
| Secrets | API keys, PSKs, OAuth client secrets, webhook secrets (`whsec_…`) | env var names / `keychain://NAME` references |
| Personal data | voice recordings, transcripts of real conversations, photos of people/rooms | synthetic test phrases, masked screenshots |
| Local paths | `/Users/<name>/…` | `~/…` or repo-relative paths |

## Evidence rules

- Crop or mask screenshots so that account avatars, names, URLs with hostnames, and chat history are not visible.
- Logs attached to issues must be passed through `scripts/redact.sh` or redacted by hand.
- Use synthetic utterances for E2E tests (e.g. "こんにちは、スタックちゃん" / "What time is it?").

## Repository checks

Run `bash scripts/check-pii.sh` to inspect tracked and non-ignored untracked files.
The scanner uses `file --mime-encoding` and converts detected UTF-16 text to UTF-8
with `iconv` before checking it. Invalid conversions fail. NUL-containing text
classified as binary also fails unless its exact bytes have been reviewed.
The scanner requires Bash, Git, awk, grep, file, iconv, and shasum (macOS/Linux).

Binary files, including images and audio, require an explicit `.pii-allowlist` entry:
`binary:<sha256>:<exact repository-relative path>`. Inspect the content and metadata
for personal information first, then obtain the digest with
`shasum -a 256 <relative-file>`. Both the path and bytes must match; replacing or
renaming the asset requires another review. No binaries are automatically allowed
by extension. The existing WAV fixture is synthesized speech, not a recording.
These checks do not perform OCR or inspect image/audio/video content.

Other allowlist entries are value EREs. Use anchored expressions for synthetic
fixtures; a permitted value never exempts its whole line or file. Only actual
pattern-definition lines in `scripts/pii-patterns.txt` are exempt. Comments there,
the scanner, redactor, and tests are all inspected. Do not add whole-file exclusions.

`bash scripts/check-pii.sh --diff <base>..HEAD` reads changed file snapshots from
every commit, including merges, rather than relying on Git text patches. It checks
the entire changed file, including unchanged lines, and catches UTF-16/binary
content even if it was removed later. The current patterns and allowlist govern
all snapshots. Diagnostics show locations and categories, with matched values
redacted. Run `bash scripts/test/pii.test.sh` for the isolated regression suite.

## Secrets at runtime

- The bridge reads secrets from environment variables only. On macOS we recommend storing them in the
  Keychain and injecting at runtime (e.g. `KEY=keychain://KEY` resolved by a keychain runner), never in `.env` files committed to git.
- Device credentials (Wi-Fi, PSK) are written to NVS over serial and never compiled into firmware defaults.

## MCP event delivery

MCP Events sends the **full recognized utterance text** outside the bridge to the verified
HTTPS callback supplied by the subscribed ChatGPT account (OpenAI for ChatGPT subscriptions).
Utterance events also contain language, duration in milliseconds, and an optional notification
reply topic (`reply_to`). Touch events contain the touched location; connection events contain
the device's online state. Each delivery includes an event ID, occurrence time, and subscription
ID. Raw microphone audio is not included in these event payloads.

Events are enabled by default when the events service is wired into the bridge. Set
`EVENTS_ENABLED=false` to disable it entirely, or set `EVENTS_SEND` to the comma-separated
event names you allow. An empty `EVENTS_SEND` disables all event types; omitting it allows all
three. Only authorized accounts can discover and subscribe. The authentication adapter must
reflect account disconnection immediately; access is rechecked before each delivery or retry.
An already running request may finish after disconnection or unsubscribe.

Subscriptions persist in a private directory (700) with a JSON file (600). Signing secrets,
previous rotation secrets, and failed delivery bodies are encrypted with AES-256-GCM using
`EVENTS_SECRET_KEY`, injected from Keychain at runtime. Callback URLs, owner identifiers,
expiration times, and retry metadata remain local plaintext management data. Keep this
directory out of version control and public evidence. Successful deliveries and exhausted or
terminal failures are removed from the retry store; unsubscribe, revoked access, or a 410
response also removes the subscription and its pending bodies. There is no event-history replay.

The events service does not log transcripts, callback URLs, or signing secrets. Optional error
reporting contains only fixed diagnostic categories. Use synthetic phrases for all tests and
recordings. See [events.md](events.md) for configuration, retention, and integration details.
