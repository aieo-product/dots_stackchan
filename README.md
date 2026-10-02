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

## Firmware

CoreS3 / K151 のセットアップは [docs/firmware.md](docs/firmware.md) を参照してください。
sanoTTS の重みは含まれません。重みなしのビルドはブリッジからの PCM 音声を再生できます。

## Voice modes

日本語かつ端末が sanoTTS 対応なら、既定で端末合成（`VOICE_MODE=device`）を使います。
`VOICE_MODE=bridge` は全言語を OpenAI TTS で合成し、PCMを端末へストリーミングします。
`TTS_VOICE` で声、`TTS_INSTRUCTIONS` で話し方を選べます。
設定・Dotの声に合わせる手順・接続APIは [docs/voice.md](docs/voice.md) を参照してください。

## License

コードは MIT。sanoTTS のモデル重みと生成音声には別の
[Model License 1.0](https://github.com/ayutaz/sanoTTS-jp/blob/v0.3.1/LICENSE-MODEL.md)
が適用されます。[NOTICE](firmware/lib/sanotts/NOTICE.md) も参照してください。
帰属表示は以下の通りです（画面を長押ししても表示できます）。

```
This model was distilled from a piper-plus teacher model.
sanoTTS-jp — https://github.com/ayutaz/sanoTTS-jp

つくよみちゃんコーパス
  本ソフトウェアの音声合成には、フリー素材キャラクター「つくよみちゃん」
  （© 夢前黎）が無料公開している音声データを使用しています。
  https://tyc.rei-yumesaki.net/material/corpus/

MOE-Speech (litagin) — https://huggingface.co/spaces/litagin/moe-speech-license
  著作権法 30 条の 4（情報解析のための利用）に基づき学習に使用。

蒸留に使用したテキストコーパス:
  - Common Voice ja (Mozilla) — CC0-1.0
      https://github.com/common-voice/common-voice
  - ROHAN4600 (森勢将雅) — CC0-1.0
      https://github.com/mmorise/rohan4600
  - ITA コーパス — CC0-1.0
      https://github.com/mmorise/ita-corpus
  - JSUT ver1.1 (高道慎之介) — CC-BY-SA-4.0 ほか（subset 別）
      https://sites.google.com/site/shinnosuketakamichi/publication/jsut

教師実装: piper-plus (MIT) — https://github.com/ayutaz/piper-plus
```
