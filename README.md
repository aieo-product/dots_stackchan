# dots_stackchan

Give your OpenAI **Dot** a body: connect an always-on [OpenAI Dot](https://openai.com/) agent to a
[Stack-chan](https://github.com/stack-chan/stack-chan) robot (M5Stack CoreS3 / K151).

> Status: bridge services are integrated; real-device acceptance is still required. See the [issues](https://github.com/aieo-product/dots_stackchan/issues) for the roadmap.

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

## Run the bridge

Node.js 22 以上（既定のかな変換には24以上を推奨）。キーを Keychain に登録し、
環境変数へ実行時だけ注入します。環境ファイルは自動で読みません。

```sh
npm install
akc set DEVICE_PSK
akc set OPENAI_API_KEY
akc set EVENTS_SECRET_KEY
export DEVICE_PSK=keychain://DEVICE_PSK
export OPENAI_API_KEY=keychain://OPENAI_API_KEY
export EVENTS_SECRET_KEY=keychain://EVENTS_SECRET_KEY
akc run -- npm run start --workspace bridge
```

`EVENTS_SECRET_KEY` は32バイトのランダム鍵を標準base64で表した値です。
Events を使わない場合は `EVENTS_ENABLED=false` でキーを省略できます。
API を使わず通信だけ試すなら `STT_ENGINE=fake EVENTS_ENABLED=false` を指定します。
fake は固定の合成テスト文を返し、実際の音声を認識しません。

| 環境変数 | 既定 / 用途 | 詳細 |
|---|---|---|
| `DEVICE_PSK`, `BRIDGE_HOST`, `BRIDGE_PORT` | PSK必須、デバイスWSは全IPv4インターフェースの8790 | [protocol](docs/protocol.md), [firmware](docs/firmware.md) |
| `STT_ENGINE`, `STT_*`, `OPENAI_API_KEY` | `openai-realtime`。ローカル認識も選択可能 | [STT](docs/stt.md) |
| `VOICE_MODE`, `TTS_ENGINE`, `KANA_ENGINE`, `LOCAL_TTS_*`, `VOICEVOX_*` | `device`、PCM fallbackは`openai`、かな変換は`wasm` | [TTS](docs/tts.md) |
| `MCP_PORT`, `MCP_HOST` | 8791、ループバックのみ。公開設定時はOAuth専用 | [MCP](docs/mcp.md) |
| `MCP_PUBLIC_URL`, `MCP_PASSCODE`, `OAUTH_*`, `MCP_LOCAL_PORT` | 公開URL未設定ならOAuth無効。設定時は別のローカルMCPを8792で起動 | [setup](docs/setup.md), [security](docs/security.md) |
| `EVENTS_ENABLED`, `EVENTS_SECRET_KEY`, `EVENTS_SEND`, `EVENTS_STORE_DIR` | 有効、保存暗号化鍵必須。3種類の署名付きイベント | [Events](docs/events.md) |
| `QUIET_HOURS`, `QUIET_ALLOW_HIGH`, `NOTIFY_DEDUP_WINDOW_S`, `LOG_NOTIFICATIONS` | 22:00–07:00、high例外なし、重複窓600秒、本文ログなし | [notifications](bridge/src/notify/README.md) |
| `SLACK_ENABLED`, `SLACK_*`, `ROUTE` | 無効。経路は`mcp` / `slack` / `both` | [Slack](docs/slack.md) |
| `FILLER_PHRASES` | 最大5文の相槌設定。空文字/`[]`で無効 | [fillers](docs/fillers.md) |
| `LOG_LEVEL`, `LOG_TRANSCRIPTS` | `info`、文字起こし本文ログなし | [privacy](docs/privacy.md), [STT](docs/stt.md) |

MCPはローカルの `http://localhost:8791/mcp` で使えます。公開する場合は
`MCP_PUBLIC_URL` と `MCP_PASSCODE` を設定し、[Funnelの手順](docs/setup.md)に従います。
公開用・ローカル用MCPとデバイスWSは独立したリスナーです。

操作対象は **最初に認証してhelloを送った1台**。切断したら、helloを受信済みの
残りの端末を登録順に選びます。音声キューは接続ごとに作り直し、古い発話は移しません。
通知キューとreply contextは1つの操作対象で共有します。複数台の同時操作は未対応です。
STTの確定発話をlisten・Events・任意のSlackへ配信し、通知再生後10秒以内に始まった
返事へ`reply_to`を付けます。SIGINT/SIGTERMで配信・再試行・音声・認識・全リスナーを停止します。

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
音声認識の設定・ローカルモデルの導入・合成 WAV の再生・遅延の計測は
[docs/stt.md](docs/stt.md) を参照してください。`STT_ENGINE=local` は OpenAI の
API キーなしで mlx-whisper または常駐 whisper-server を使えます。
