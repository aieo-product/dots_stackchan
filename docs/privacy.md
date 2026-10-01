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
- Logs attached to issues must be passed through `scripts/redact.sh` (planned) or redacted by hand.
- Use synthetic utterances for E2E tests (e.g. "こんにちは、スタックちゃん" / "What time is it?").

## Secrets at runtime

- The bridge reads secrets from environment variables only. On macOS we recommend storing them in the
  Keychain and injecting at runtime (e.g. `KEY=keychain://KEY` resolved by a keychain runner), never in `.env` files committed to git.
- Device credentials (Wi-Fi, PSK) are written to NVS over serial and never compiled into firmware defaults.
