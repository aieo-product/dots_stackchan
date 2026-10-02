# 発話と音声合成 (#7)

既定は端末の sanoTTS-jp。ブリッジで文を分け、漢字かな交じり文を「ひらがな＋アクセント記号」に変えて `speak.kana {seq, kana, expression?}` を送る。端末は合成しながら再生し、再生完了後に `tts.done {seq, ok}` を返す。

日本語以外、`caps.sanotts=false`、または `TTS_ENGINE=openai` の場合は OpenAI の PCM 経路へ進む。日本語の判定はかなを含むことを基準にしており、漢字だけの短文は OpenAI に送る（中国語との誤判定を避けるため）。漢字、数字、英字が混じった日本語は WASM の辞書で読みを補う。未知の製品名も 45 文の評価セットに含めている。発音の正しさは実機での確認が必要。

## 設定

ブリッジの環境変数スキーマに `ttsEnvSchema.shape` を統合する。各モジュールには型付き options を渡し、環境ファイルは読まない。

| キー | 既定 | 内容 |
| --- | --- | --- |
| `TTS_ENGINE` | `sanotts` | `sanotts` / `openai` |
| `KANA_ENGINE` | `wasm` | Python 不要の `wasm` / 任意の精度優先 `python` |
| `TTS_VOICE` | `coral` | OpenAI の声 |
| `TTS_INSTRUCTIONS` | 明るく親しみやすい英語の指示 | OpenAI の声色・速さへの指示 |
| `TTS_MAX_CHARS` | `500` | 1〜500。Unicode コードポイント数で制限 |
| `OPENAI_API_KEY` | なし | PCM 経路を利用するときだけ必要 |

OpenAI クライアントは遅延生成するため、日本語の sanoTTS 経路は API キーなしで使える。秘密値は Keychain から子プロセスへ注入する。ログや設定ファイルには書かない。音声が AI 生成であることを利用者に表示すること（[OpenAI 公式 TTS ドキュメント](https://developers.openai.com/api/docs/guides/text-to-speech)）。VOICEVOX は最終仕様の対象外。

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

95% に届かなかったため、最新の指示に従い TS/WASM を既定にし、Python は明示選択のみとした。文別の出力は `evaluation.json`、不採用候補の出力は `c-wasm-evaluation.json` / `kanji2koe-evaluation.json` にある。入力の URL は「リンク」に、絵文字とマークアップ記号は空白に置き換える。数詞は辞書で読む。変換できない音素を黙って削除せず失敗として扱う。

`piper-plus` の npm パッケージは Node >=24 を宣言している。リポジトリ全体は Node >=22 のまま。この経路を使う場合は **Node 24 以降**を推奨する。パッケージを更新するときは WASM の ID 配列構造と 45 文の一致率を再評価する。

通常の `npm run check` は Python・ネットワーク・API キーを使わない。正解の再生成は開発者が upstream checkout を用意して実行する:

```sh
uv run --no-project --with piper-plus-g2p==0.2.0 \
  --with pyopenjtalk-plus==0.4.1.post9 python \
  bridge/test/fixtures/tts/generate-goldens.py <sanotts-checkout>
```

任意の実プロセス評価は、同じバージョンをインストールした Python 実行ファイルを `TTS_EVAL_PYTHON` に指定し、`npx vitest run bridge/test/tts-evaluation.test.ts` を実行する。`TTS_EVAL_WRITE=1` で文別の結果を更新する。C/WASM の評価に使った labels の JSON を用意した場合は `TTS_EVAL_C_LABELS` で比較できる。通常の CI ではこの 2 件をスキップし、sidecar の起動・応答・タイムアウト・終了は Node の偽プロセスで検証する。

## キューと統合

`SpeechQueue` は #8 と共有する `speaker.ts` の `Speaker` に適合する。`say` は同期的に enqueue して `{id, estimatedSeconds, done}` を直ちに返す。`estimatedSeconds` は切り詰め後の文字数 × 0.15。各文の `tts.done {ok:true}` を受けたときだけ次の文へ進み、全て成功すると ticket の `done` が resolve する。

`interrupt:true` は現在の合成・転送・再生と待機中の ticket を中止し、`tts.cancel` を送って新しい発話へ進む。`cancelAll()`、切断、タイムアウト、変換失敗、`ok:false` では ticket を reject する。AbortSignal を無視する変換器もキューを止め続けない。遅れて届く別 seq の done は無視する。1 接続内で 16-bit seq を再利用しないため、65,535 文の送信後は新しい接続用キューを作る。

最初の短い文はすぐ送り、後続の短い文は 15 字以上になるまでまとめる。`。！？!?` と改行で分割する。500 字を超える部分は切り捨て、`tts.truncated` に文字数だけを出す。

`speaking` イベントの boolean は合成前から転送・再生終了まで true。キューが空になると false。#6 はこのイベントでマイクを停止・再開する。`tts.sent` ログには `queuedToSendMs`（enqueue から送信まで）と `conversionToSendMs`（その文の変換開始から送信まで）を記録する。待機中の文の前者にはキュー待ちを含む。ログに発話内容、キー、接続先、provider error は出さない。

#4 のファイルは本 issue で変更していない。統合時に、選択されたデバイスの接続を `DeviceLink` へ適合させる。必要なメソッドは `send` / `sendBinary` / `on` / `off`、プロパティは `online` / `caps`。受信の `tts.done` は `message` イベントへ、接続切断は `offline` へ流す。`sendBinary` は v1 の `[kind u8][seq u16 LE]` ヘッダーを付ける責務を持つ。キューはヘッダーを二重に付けない。

```ts
import { createKanaConverter, OpenAiTtsEngine, SpeechQueue, TtsRouter,
  ttsEnvSchema, type Speaker } from './tts/index.js';

// device: 選択した端末に対応する DeviceLink adapter
const options = ttsEnvSchema.parse(process.env);
const kana = await createKanaConverter(options); // 受付前に辞書・解析器を温める
let pcm: OpenAiTtsEngine | undefined;
const router = new TtsRouter(options, kana,
  () => pcm ??= OpenAiTtsEngine.create(options, process.env.OPENAI_API_KEY));
const queue = new SpeechQueue(device, router, { maxChars: options.TTS_MAX_CHARS });
queue.on('speaking', (active: boolean) => { /* #6 のマイク制御へ通知 */ });
const speaker: Speaker = queue;
const ticket = speaker.say('こんにちは。今日もがんばろう。', { expression: 'happy' });
await ticket.done;
// 終了時: queue.dispose(); kana.dispose();
```

## PCM 経路

[OpenAI の公式仕様](https://developers.openai.com/api/docs/guides/text-to-speech)に合わせ、`gpt-4o-mini-tts` の 24kHz/16-bit/mono signed little-endian PCM を取得し、窓付き sinc の low-pass filter で 16kHz に変換する。高域の aliasing 抑制もテストしている。

1 文をまとめて合成し、`tts.start {seq, sample_rate:16000, channels:1, bits:16}` → kind `0x02` の PCM → `tts.end {seq}` の順に送る。PCM payload は 4,092 bytes 以下、3-byte header を含むフレームは 4,095 bytes 以下。表情は PCM の開始前に `face` で送る。端末での逐次 PCM 再生は今回の対象外。

## ライセンスと実機確認

sanoTTS-jp のコードは [MIT](https://github.com/ayutaz/sanoTTS-jp/blob/main/LICENSE)。かな変換の凍結テーブルの出典と許諾文は `bridge/src/tts/LICENSE-sanotts` に保存した。**端末のモデル重みと生成音声には別の [モデルライセンス](https://github.com/ayutaz/sanoTTS-jp/blob/main/LICENSE-MODEL.md) がある**。重みを含む firmware の配布時は上流のモデルライセンス・NOTICE の条件を確認する。本変更はモデル重みを同梱しない。WASM 内の OpenJTalk / jpreprocess / NAIST-JDIC の帰属は npm パッケージ同梱の第三者ライセンスに従う。

45 文で温めた WASM の変換時間は開発環境で p95 約 **0.82ms**（Node 24、単回測定）。これは送信・端末の合成・音声出力を含まない。`conversionToSendMs` の目標 50ms と、文字到着から音が出るまでの目標 0.6 秒は、統合したブリッジと実機で測る必要がある。#4 の配線、#6 のマイク連動、K151 の音量・発音・口パク、割り込みによる再生停止、部屋や人の写らない短い動画とログの E2E 証拠は統合後に確認する。ファームウェアは変更していない。
