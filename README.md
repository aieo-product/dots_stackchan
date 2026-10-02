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

Node.js 22 以上と PlatformIO が必要です。

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

## License

MIT

音声認識の設定・ローカルモデルの導入・合成 WAV の再生・遅延の計測は
[docs/stt.md](docs/stt.md) を参照してください。`STT_ENGINE=local` は OpenAI の
API キーなしで mlx-whisper または常駐 whisper-server を使えます。
