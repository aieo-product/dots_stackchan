# 発話と音声合成 (#7)

`VOICE_MODE=device` は端末の sanoTTS-jp、`VOICE_MODE=bridge` はブリッジでの音声合成。両方で同じ `Speaker` / `SpeechQueue`、割り込み、`speaking` イベント、`tts.done {seq, ok}` を使う。

未設定では device mode を選ぶ。日本語かつ `caps.sanotts=true` なら、漢字かな交じり文を「ひらがな＋アクセント記号」に変えて `speak.kana {seq, kana, expression?}` を送る。端末は合成しながら再生する。日本語以外または `caps.sanotts=false` は `TTS_ENGINE` の PCM にフォールバックする。かなを含むことを日本語の基準とし、漢字だけの短文は PCM に送る。漢字・数字・英字・未知の製品名は 45 文の評価に含めている。発音は実機で確認する。

bridge mode は日本語を含む **すべての文**を `TTS_ENGINE` で合成する。既定エンジンは OpenAI。VOICEVOX と local-http も明示選択できる。端末には既存の `voice.mode` で現在の mode を表示する。エンジン名はブリッジ内のメタデータとして扱い、v1の音声フレームへ追加しない。接続・設定変更時に `router.announceMode(device)` を呼ぶと、発話前にも表示を更新できる。

## 設定

`ttsEnvSchema.parse(process.env)` で正規化・検証した options を各モジュールに渡す。環境ファイルは読まない。

| キー | 既定 | 内容 |
| --- | --- | --- |
| `VOICE_MODE` | `device` | `device` / `bridge` |
| `TTS_ENGINE` | `openai` | PCM の `openai` / `voicevox` / `local-http` |
| `NOTIFY_TTS_ENGINE` | `TTS_ENGINE` と同じ | 通知用の PCM エンジン |
| `KANA_ENGINE` | `wasm` | Python 不要の `wasm` / 任意の精度優先 `python` |
| `TTS_VOICE` | `coral` | OpenAI の声 |
| `TTS_MODEL` | `gpt-4o-mini-tts` | OpenAI Speech のモデル。`tts-1` / `tts-1-hd` も選択可 |
| `TTS_INSTRUCTIONS` | 明るく親しみやすい英語の指示 | OpenAI の任意の声色・速さ指示。空文字で無効 |
| `TTS_MAX_CHARS` | `500` | 1〜500。Unicode コードポイント数で制限 |
| `OPENAI_API_KEY` | なし | PCM 経路を利用するときだけ必要 |
| `VOICEVOX_URL` | なし | VOICEVOX 選択時に必須。エンジンの base URL |
| `VOICEVOX_SPEAKER` | `0` | `/speakers` の style ID |
| `LOCAL_TTS_URL` | なし | local-http 選択時に必須。POST の完全な URL |
| `LOCAL_TTS_TOKEN` | なし | 任意の Bearer token。秘密値として注入 |
| `LOCAL_TTS_TIMEOUT_MS` | `30000` | local-http のヘッダー・body を含む期限 |
| `LOCAL_TTS_VOICE` / `LOCAL_TTS_STYLE` | なし | ローカルサーバーの voice / style |
| `LOCAL_TTS_SEED` / `LOCAL_TTS_SPEED` | なし | 整数 seed / 正の speed |

エンジンは遅延生成する。日本語の sanoTTS やローカルエンジンは OpenAI キーなしで使える。秘密値は Keychain から子プロセスへ注入し、`createTtsRouter` の secrets 引数で渡す。ログや設定ファイルには書かない。音声が AI 生成であることを利用者に表示すること（[OpenAI 公式 TTS ドキュメント](https://developers.openai.com/api/docs/guides/text-to-speech)）。

旧設定は互換性を保つ: `TTS_ENGINE=sanotts` は device + OpenAI fallback、`VOICE_MODE` 未設定で `TTS_ENGINE=openai` / `voicevox` / `local-http` を明示した場合は bridge にする。`VOICE_MODE` を明示するとその値が優先する。日本語の通知にも別エンジンを使いたい場合は bridge mode にし、`speaker.say(text, {purpose:'notification'})` として enqueue する。device mode の日本語では通知も sanoTTS を使う。

### Dot の声に合わせる

ChatGPT で Dot に選んだ声の表示名を確認し、[API の voice options](https://developers.openai.com/api/docs/guides/text-to-speech#voice-options) に同じ ID がある場合は `VOICE_MODE=bridge`、`TTS_ENGINE=openai`、`TTS_VOICE=<voice-id>` とする。たとえば `coral`。ChatGPT の表示名と API ID の対応表・自動同期は公式資料で確認できていないため、名前が一致しない声は API の試聴から近い声を選ぶ。ChatGPT の声を完全に再現する保証はない。`TTS_INSTRUCTIONS` で明るさ・話速などを調整できる。

## かな変換の評価

テスト用に独自に作った **45 文**の入力・正解・full-context labels を `bridge/test/fixtures/tts/{sentences,golden}.json` に保存した。正解は [sanoTTS-jp の `scripts/kana_g2p.py`](https://github.com/ayutaz/sanoTTS-jp/blob/3eb73a91acdb8d4bc0cc10c3bc4e670555ce20bc/scripts/kana_g2p.py) の `text_to_intermediate` で生成した。開発時のみ `piper-plus-g2p==0.2.0` / `pyopenjtalk-plus==0.4.1.post9` を使った。BOS `^` と平叙文 EOS `$` はプロトコルで暗黙なので除去し、疑問 EOS は残す。上流 checkout はコミットしていない。

| 候補・経路 | 完全一致 | 導入・判断 |
| --- | --- | --- |
| `piper-plus 0.7.0` jpreprocess WASM + TS 移植 | **16/45 (35.56%)** | **既定**。辞書同梱、Python・ネイティブビルド・実行時ダウンロード不要。WASM 本体 60,077,874 bytes |
| `piper-plus 0.1.1` C OpenJTalk WASM + TS 移植 | 14/45 (31.11%) | labels 取得は可能。web 専用ビルドを隔離した JS realm で評価した。外部辞書と初期化用 HTS voice が必要。既定に採用しない |
| `kanji2koe-openjtalk 0.1.0` | sanoTTS 形式の一致 0/45 | AquesTalk 形式を返し、labels は非公開。形式比較の数字であり、読みの精度が 0% という意味ではない。WASM 本体 20,469,322 bytes。採用しない |
| 任意の Python mode + 同じ凍結テーブル | **45/45 (100%)** | 常駐 JSON-lines sidecar。`uv` と Python が必要。初回のみパッケージ取得 |
| TS 移植に上流 labels を直接入力 | **45/45 (100%)** | CI で検証。残る WASM 差は解析器・辞書・読み・アクセント・無声化の差 |

`labels.ts` が A1/A2/A3 の上昇・下降核・句境界と疑問 EOS を処理し、`phonemes.ts` が上流の凍結 mora table と alias 順、モーラ内部の記号移動、無声化を移植している。現行 WASM は full-context label 文字列を公開せず、**現在の音素と A1/A2/A3** を公開する。この必要なフィールドからラベルの最小表現を作り、同じ TS ロジックを実行する。PAD とポーズは ID が同じなので、値で PAD を除去せず token の位置で識別する。

既存の主実装は Python 不要の TS/WASM を既定にしているが、上流との完全一致は 16/45 に留まる。厳密な上流一致が必要な場合は `KANA_ENGINE=python` を選ぶ。文別の出力は `evaluation.json`、不採用候補の出力は `c-wasm-evaluation.json` / `kanji2koe-evaluation.json` にある。入力の URL は「リンク」に、絵文字とマークアップ記号は空白に置き換える。数詞は辞書で読む。変換できない音素を黙って削除せず失敗として扱う。

`piper-plus` の npm パッケージは Node >=24 を宣言している。リポジトリ全体は Node >=22 のまま。この経路を使う場合は **Node 24 以降**を推奨する。パッケージを更新するときは WASM の ID 配列構造と 45 文の一致率を再評価する。

通常の `npm run check` は Python・ネットワーク・API キーを使わない。正解の再生成は開発者が upstream checkout を用意して実行する:

```sh
uv run --no-project --with piper-plus-g2p==0.2.0 \
  --with pyopenjtalk-plus==0.4.1.post9 python \
  bridge/test/fixtures/tts/generate-goldens.py <sanotts-checkout>
```

任意の実プロセス評価は、同じバージョンをインストールした Python 実行ファイルを `TTS_EVAL_PYTHON` に指定し、`npx vitest run bridge/test/tts-evaluation.test.ts` を実行する。`TTS_EVAL_WRITE=1` で文別の結果を更新する。C/WASM の評価に使った labels の JSON を用意した場合は `TTS_EVAL_C_LABELS` で比較できる。通常の CI ではこの 2 件をスキップし、sidecar の起動・応答・タイムアウト・終了は Node の偽プロセスで検証する。

## キューと統合

`SpeechQueue` は #8 と共有する `speaker.ts` の `Speaker` に適合する。`say` は同期的に enqueue して `{id, estimatedSeconds, done}` を直ちに返す。`estimatedSeconds` は切り詰め後の文字数 × 0.15。次の文の HTTP は現在の文の最初の PCM フレームを送った直後に開始し、最初の出力チャンクまで先行取得する。先行取得は 1 文だけ。現在の文の転送終了と `tts.done {ok:true}` の両方を待ってから次の文を端末へ送る。全て成功すると ticket の `done` が resolve する。

`interrupt:true` は現在の合成・転送・再生と待機中の ticket を中止し、`tts.cancel` を送って新しい発話へ進む。`cancelAll()`、切断、タイムアウト、変換失敗、`ok:false` では ticket を reject する。AbortSignal を無視する変換器もキューを止め続けない。遅れて届く別 seq の done は無視する。1 接続内で 16-bit seq を再利用しないため、65,535 文の送信後は新しい接続用キューを作る。

最初の短い文はすぐ送り、後続の短い文は 15 字以上になるまでまとめる。`。！？!?` と改行、英語のピリオド後の空白で分割する。500 字を超える部分は切り捨て、`tts.truncated` に文字数だけを出す。

`speaking` イベントは合成前から転送・再生終了まで true、キューが空になると false。#6 はこのイベントでマイクを停止・再開する。`tts.sent` は送信終了時の `queuedToSendMs` と `conversionToSendMs` を記録する。PCM は各文の最初のフレームで `tts.first_audio` を記録する: `firstAudioMs` はその文のリクエスト開始から送信まで（先行取得後の再生待ちを含む）、`replyToFirstAudioMs` は enqueue から送信まで。最初の文の目標は後者が **800ms 以下**。`sentence`、`targetMs`、`targetMet` も残す。後続文の targetMet はその文のリクエスト開始を基準にする。発話内容・キー・接続先・provider error はログに出さない。

`bridge/src/app/device.ts` が、選択されたデバイスの接続を共有の `DeviceLink` へ適合させる。必要なメソッドは `send` / `sendBinary` / `on` / `off`、プロパティは `online` / `caps`。受信の `tts.done` は `message` イベントへ、接続切断は `offline` へ流す。`sendBinary` は v1 の `[kind u8][seq u16 LE]` ヘッダーを付ける責務を持つ。キューはヘッダーを二重に付けない。

```ts
import { createKanaConverter, createTtsRouter, SpeechQueue,
  ttsEnvSchema, type Speaker } from './tts/index.js';

// device: 選択した端末に対応する DeviceLink adapter
const options = ttsEnvSchema.parse(process.env);
const kana = await createKanaConverter(options); // 受付前に辞書・解析器を温める
const router = createTtsRouter(options, kana, {
  openaiApiKey: process.env.OPENAI_API_KEY,
  localTtsToken: process.env.LOCAL_TTS_TOKEN,
});
router.announceMode(device);
const queue = new SpeechQueue(device, router, { maxChars: options.TTS_MAX_CHARS });
queue.on('speaking', (active: boolean) => { /* #6 のマイク制御へ通知 */ });
const speaker: Speaker = queue;
const ticket = speaker.say('こんにちは。今日もがんばろう。', { expression: 'happy' });
await ticket.done;
// 起動時: await router.warmup(); // 接続の温めに失敗しても起動は継続可能
// 終了時: queue.dispose(); await router.dispose(); kana.dispose();
```

## PCM 経路

[OpenAI の公式仕様](https://developers.openai.com/api/docs/guides/text-to-speech)に合わせ、`gpt-4o-mini-tts` の 24kHz/16-bit/mono signed little-endian PCM を取得し、窓付き sinc の low-pass filter で 16kHz に変換する。高域の aliasing 抑制もテストしている。

HTTP body を逐次読み、最初の出力ができた時点で `tts.start {seq, sample_rate:16000, channels:1, bits:16, voice_mode:'bridge', engine}` → kind `0x02` の PCM → `tts.end {seq}` の順に送る。PCM payload は 4,092 bytes 以下、3-byte header 込みで 4,095 bytes 以下。リサンプラーはサンプル途中のバイト、stereo の channel 境界、filter 履歴、出力位置を保持し、文末だけ flush する。WAV と raw PCM の共通経路も同じ filter を使う。入力は 1 応答 16MiB 以下、空音声・不完全サンプル・非有限 float は失敗にする。

端末の固定バッファに収まるよう、約 200ms の送信先行量に制限する。HTTP が遅れても先行量の余裕を蓄積しない。表情は PCM の開始前に `face` で送る。`tts.cancel` は再生停止と同時に現在・先行取得中の HTTP body を abort/cancel する。期限は OpenAI / VOICEVOX が 30 秒、local-http が設定値で、ヘッダーだけでなく body の途中にも適用する。

### 低遅延と区間計測 (#30)

2026-10-02 に [OpenAI 公式 TTS ガイド](https://developers.openai.com/api/docs/guides/text-to-speech)を確認した。最速の応答形式として PCM / WAV、リアルタイム用途には `gpt-4o-mini-tts` を推奨している。`tts-1` の[モデル仕様](https://developers.openai.com/api/docs/models/tts-1)は速度重視とされるが、mini との数値比較は示されていない。声色指示を維持する既定は mini + PCM。`TTS_MODEL=tts-1` も比較できるが、`TTS_INSTRUCTIONS` は非対応なので送らない。`tts-1-hd` は遅延優先には推奨しない。[廃止予定](https://developers.openai.com/api/docs/deprecations)では既存 TTS モデルの 2027-01-06 終了と Realtime への移行が案内されている。Realtime API への移行はこの Speech HTTP 修正の範囲外。

修正前も SDK の binary response は生の `Response` を返し、`responseBytes` は body を逐次読んでいた。キューにも次文の準備処理はあった。従って、報告された実 API の 2540ms を「全音声のバッファリング」や「先読みが無かったこと」の結果とは断定できない。従来の即時応答テストには API の最初のバイトまでの待ち時間がなく、区間ログも不足していた。

OpenAI 用に [undici Agent](https://github.com/nodejs/undici/blob/main/docs/docs/api/Agent.md) を所有し、同時接続数を 2、HTTP pipelining を 1、keep-alive の上限を 60 秒とする。前文の body が開いていても次文は別ソケットで開始でき、その後は再利用する。bridge mode ではアプリ受付前に認証不要の `GET /audio/speech` を 2 本送り、応答を読み切って接続を温める。これは音声生成を行わず、401/405 でも接続確立には使える。HEAD は undici が通常接続を閉じるため使わない。温めは 10 秒で期限切れとし、失敗時もアプリは起動を継続する。サーバーが接続を閉じた場合や長い無音期間後は再接続する。終了時は `router.dispose()` でプールを破棄する。device mode のエンジンは引き続き遅延生成する。

OpenAI の HTTP / body 全体の期限は 30 秒。自動リトライは待ち時間を隠さないよう無効にした。SDK 独自のログも無効にし、provider の応答、入力、認証情報を区間ログへ出さない。

`LOG_LEVEL=debug` では以下を記録する。時間は単調時計で測った ms。HTTP ログの `request` はエンジン内の連番、キューログの `sentence` / `seq` は文・送信の順番。

| イベント | 区間・値 |
| --- | --- |
| `tts.http_connect` | 新しい接続の DNS / TCP / TLS 合計 `connectionMs`。再利用時は発生しない |
| `tts.http_warmup` | 起動前の事前接続 `warmupMs` / `ok` |
| `tts.prepare` | enqueue → 文の準備開始 `queuedToPrepareMs`、`prefetched` |
| `tts.http_request` | HTTP 開始、モデル |
| `tts.http_headers` | HTTP 開始 → ヘッダー `headersMs` |
| `tts.http_first_byte` | HTTP 開始 → 最初の PCM バイト `firstByteMs` |
| `tts.conversion_first` / `tts.conversion` | 最初の出力 / 全出力の変換 CPU 時間 `conversionMs`、`outputBytes`。ネットワーク・再生待機を除く |
| `tts.http_body` | HTTP 開始 → body 消費完了 `bodyMs`。送信ペーシング・先読み待機も含む |
| `tts.first_audio` | enqueue → 最初の送信 `replyToFirstAudioMs`、準備完了 → 最初の送信 `firstFrameSendMs` |
| `tts.sent` | 送信開始 → 終了 `sendMs`。HTTP 受信待ち・ペーシングを含む |

次文の準備は最初の PCM 送信直後（sanoTTS は `speak.kana` 送信直後）に開始する。先行取得は次の 1 文の最初の変換チャンクまで。OpenAI / VOICEVOX / local-http と、stream のないエンジンで共通。次文の送信は前文の送信完了と `tts.done` を両方待つ。割り込みは送信中・先読み中の HTTP を両方中止する。

`bridge/test/fixtures/fake-openai-tts.ts` は実 HTTP の偽 OpenAI サーバー。ヘッダーを先に返し、最初の PCM は 300ms 後、その後は 50ms 間隔で合計 10 チャンクを送り、最後のチャンクから 50ms 後に EOF とする。3 文のテストで EOF 前の送信、最初のフレーム以後かつ前文の EOF 前の次文 HTTP、done による送信待機、2 本の温めたソケットの再利用、割り込み時の両 body の終了を確認する。別途 5 回計測も毎回 timings を出力する。

偽 API の計測結果（単回テスト実行、実 API の保証ではない）:

| 回 | `replyToFirstAudioMs` |
| --- | ---: |
| 1 | 303.18 |
| 2 | 302.96 |
| 3 | 302.92 |
| 4 | 302.61 |
| 5 | 301.03 |
| 中央値 | **302.92** |

1 回目の区間例はヘッダー 0.72ms、最初のバイト 302.53ms、最初の変換 CPU 0.54ms、最初の送信処理 0.04ms。次文の準備は enqueue 後 303.19ms、前文の送信完了は 812.14ms。3 文で送信した PCM は合計 48,000 bytes、payload は全て 4,092 bytes 以下。

実 API の計測（2026-10-02、Apple Silicon の Mac、`gpt-4o-mini-tts`、PCM、温めた接続、2 文の返事を 5 回）:

| 回 | 返事 → 最初の PCM フレーム | OpenAI の最初のバイトまで | ブリッジの処理（変換・送信） |
|---:|---:|---:|---:|
| 1 | 2,952 ms | 2,950 ms | 約 1 ms |
| 2 | 916 ms | 914 ms | 約 2 ms |
| 3 | 9,415 ms | 9,413 ms | 約 1 ms |
| 4 | 644 ms | 642 ms | 約 2 ms |
| 5 | 601 ms | 596 ms | 約 5 ms |

中央値 916 ms（目標 800 ms）。**ブリッジ側の処理は数 ms で、待ち時間のほぼすべては OpenAI の最初のバイトまでの時間**だった。値は 0.6〜9.4 秒と大きくばらつく。先読みは効いており、2 文目の要求は 1 文目の最初のフレームを送った時点で出ている。目標の 800 ms は OpenAI 側の応答に左右されるため、ブリッジでは保証できない。速さを優先する場合は、端末の sanoTTS（`VOICE_MODE=device`）か、ローカルの TTS（`local-http` / `voicevox`）を使う。

```sh
OPENAI_API_KEY=keychain://OPENAI_API_KEY akc run -- \
  npx vitest run bridge/test/tts-latency.test.ts
```

実 API テストは `skipIf(!OPENAI_API_KEY)`。起動時に接続を温め、同じ 2 文を `SpeechQueue.say` へ 5 回送り、各回の区間ログと最終中央値を標準出力に出す。中央値は記録だけ行い、合否には使わない（実 API の応答はネットワークとサーバーの混み具合で大きくばらつくため）。`TTS_MODEL=tts-1` を付ければ速度重視モデルも同じ条件で比較できる。偽端末は `tts.end` で done を返すため、実スピーカーの音が出るまでの時間は実機で別途確認する。

### VOICEVOX

`VOICE_MODE=bridge`、`TTS_ENGINE=voicevox`、`VOICEVOX_URL=http://<your-host>:50021`、`VOICEVOX_SPEAKER=<style-id>` を指定する。`POST /audio_query?text=...&speaker=...` の JSON を `POST /synthesis?speaker=...` に渡す。[エンジン公式 API](https://github.com/VOICEVOX/voicevox_engine/blob/master/README.md) に沿う。未起動ならエンジン起動・URL・speaker の確認を促すエラーにする。音声の配布・利用には **VOICEVOX のクレジット表記と選んだ音声ライブラリの規約確認が必要**。表示例は `VOICEVOX:<character>`（[公式利用規約](https://voicevox.hiroshiba.jp/term/)）。

### Local TTS HTTP contract v1

`VOICE_MODE=bridge`、`TTS_ENGINE=local-http`、`LOCAL_TTS_URL=http://<your-host>:<port>/tts` を指定する。URL は必須で、暗黙のエンドポイントはない。

リクエストは `POST <LOCAL_TTS_URL>`、`Content-Type: application/json`。漢字かな交じりのまま、1 文または数文、500 Unicode 文字以下を送る。サーバーは未知のフィールドを無視する。

```json
{ "text": "こんにちは。", "voice": "<voice>", "style": "<style>", "seed": 42, "speed": 1.0 }
```

`text` だけ必須。残りは対応する `LOCAL_TTS_*` が設定された場合だけ送る。token 設定時は `Authorization: Bearer <LOCAL_TTS_TOKEN>`。認証情報を別の宛先に転送しないため HTTP redirect は追わない。

成功応答は次のどちらか:

- `200`、`Content-Type: audio/wav`。任意の正の整数 sample rate、mono / stereo、PCM s16le または IEEE float32。RIFF の `fmt ` / `data`、拡張 fmt、途中の未知 chunk と padding を処理し、data を逐次変換する。
- `200`、`Content-Type: audio/pcm;rate=<hz>;channels=<n>;format=s16le|f32le`。raw little-endian PCM。chunked / streaming に対応し、到着順に変換・送信する。channels は 1 または 2。

失敗応答は non-2xx、JSON `{ "error": "..." }`。ブリッジは provider の error 内容をログへ転記せず、確認項目を示すエラーにする。`LOCAL_TTS_TIMEOUT_MS` の既定は 30000。遅いモデルでも次の文を先行リクエストし、再生順は変えない。

任意の `GET <base>/health` はモデル読み込み完了時に 200。`<base>` は POST URL の最後の path 要素を除いた位置（`/api/tts` → `/api/health`）。`router.health('reply'|'notification')` を status / doctor から呼べる。結果は `ready` / `unavailable` / `unsupported`（404）。VOICEVOX は `/version`、OpenAI は health API 未提供として unsupported を返す（キー不足は unavailable）。このブランチには doctor コマンド本体はまだない。

`bridge/test/fixtures/fake-local-tts.ts` は未知フィールドを無視して 48kHz の sine WAV を返す小さな参照サーバー。`fake-voicevox.ts` は query + synthesis の偽エンジン。テストが一時 port で起動し、終了時に閉じる。

### 端末の PCM ストリーミング

統合したファームウェアは `firmware/src/audio/player.cpp` と
`speech_dispatcher.cpp` が、認証済みWebSocketのprotocol v1音声を再生する。
起動時の `hello.caps.sanotts` は重みの有無を反映し、重みがなければブリッジはPCMへ
フォールバックする。`tts.done` を待って次の文を送信し、PTT開始・切断・割り込み時は
現在と待機中の発話を中止する。バッファ、I2S切り替え、ビルドと実機確認の詳細は
[firmware.md](firmware.md)を参照する。

通常の検証は `npm run check`（C++コンパイラも必要）、`cd firmware && pio run`。
`bridge/test/e2e-integration.test.ts` は実アプリのMCP・認証済みWebSocket・偽local-http
エンジンを結線し、かな、PCM、capability fallback、完了待機、PTTと終了を確認する。
偽OpenAIのストリーミング結合テストも別に存在する。これらは実API・実機の遅延保証ではない。

## ライセンスと実機確認

sanoTTS-jp のコードは [MIT](https://github.com/ayutaz/sanoTTS-jp/blob/main/LICENSE)。かな変換の凍結テーブルの出典と許諾文は `bridge/src/tts/LICENSE-sanotts` に保存した。**端末のモデル重みと生成音声には別の [モデルライセンス](https://github.com/ayutaz/sanoTTS-jp/blob/main/LICENSE-MODEL.md) がある**。重みを含む firmware の配布時は上流のモデルライセンス・NOTICE の条件を確認する。本変更はモデル重みを同梱しない。WASM 内の OpenJTalk / jpreprocess / NAIST-JDIC の帰属は npm パッケージ同梱の第三者ライセンスに従う。

45 文で温めた WASM の変換時間は開発環境で p95 約 **0.82ms**（Node 24、単回測定）。これは送信・端末合成・音声出力を含まない。sanoTTS の送信 50ms / 音声開始 0.6 秒と、実 OpenAI での最初の PCM フレーム 0.8 秒は、統合したブリッジと実機で測る必要がある。#4/#5 の配線・sanoTTS 合成、#6 のマイク連動、K151 の音量・発音・口パク、割り込み再生停止、部屋や人の写らない動画とログの E2E 証拠は統合後に確認する。
