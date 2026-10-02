# dots_stackchan

Give your OpenAI **Dot** a body: connect an always-on [OpenAI Dot](https://openai.com/) agent to a
[Stack-chan](https://github.com/stack-chan/stack-chan) robot (M5Stack CoreS3 / K151).

> Status: early design. See the [issues](https://github.com/aieo-product/dots_stackchan/issues) for the roadmap.

## Concept

```
 ┌──────────────┐  WSS (PSK-HMAC)   ┌──────────────────────┐  HTTPS (Tailscale Funnel)  ┌───────────┐
 │ Stack-chan   │ ◀───────────────▶ │ Host bridge          │ ◀────────────────────────▶ │ ChatGPT / │
 │ CoreS3       │  mic PCM ↑        │  - device gateway    │   MCP tools  (say, face…)  │ your Dot  │
 │ face / servo │  TTS PCM ↓        │  - STT / TTS         │   MCP Events (utterance…)  │           │
 └──────────────┘                   │  - MCP server        │                            └───────────┘
                                    │  - Slack adapter     │ ◀──── Slack (Socket Mode) ────▶ Dot in Slack
                                    └──────────────────────┘
```

- **MCP App route (primary)**: the bridge exposes Stack-chan as an MCP app. Your Dot calls tools such as
  `say`, `set_expression`, `look`, `get_status`; what Stack-chan hears is pushed to the Dot via MCP Events.
- **Slack route (secondary)**: Stack-chan's utterances are posted to a Slack channel where your Dot lives,
  and the Dot's replies are spoken back.

## Privacy

This is an OSS project. Never commit or paste personal information (tailnet hostnames, IPs, SSIDs,
e-mail addresses, real names, API keys, voice recordings) into code, issues, PRs, or evidence.
See [docs/privacy.md](docs/privacy.md).

## Development

Node.js 22 以上、PlatformIO、C++ コンパイラが必要です（WASM のかな変換は Node.js 24 以降を推奨）。

```sh
npm install
npm run check
bash scripts/test/pii.test.sh
bash scripts/check-pii.sh
cd firmware && pio run
```

`npm run check` は lint、型検査、テスト、個人情報チェックを順に実行します。ログを共有する前には
`scripts/redact.sh` を通してください。`spikes/` は試作コードのため Node.js の lint・型検査対象外です。

開発への参加方法は [CONTRIBUTING.md](CONTRIBUTING.md) を参照してください。

発話モジュールは `VOICE_MODE=device`（日本語の端末 sanoTTS）と `VOICE_MODE=bridge`
（OpenAI / VOICEVOX / local-http の PCM）に対応します。設定・ローカル HTTP 契約・
端末のストリーミング再生と統合待ちの範囲は [docs/tts.md](docs/tts.md) を参照してください。

## License

MIT
