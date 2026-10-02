# Voice modes

ブリッジの音声設定とキューは `bridge/src/speech/` にあります。端末ごとに
`hello.caps` を受けて `createSpeechQueue` を作り、Dot の返信を `queue.say` に渡します。

| Config | Behavior |
|---|---|
| `VOICE_MODE` 未指定 | 日本語（`ja` / `ja-JP` 等）かつ `caps.sanotts=true` なら device。それ以外は bridge |
| `VOICE_MODE=device` | 日本語を端末の sanoTTS で合成。読みを `speak.kana` で送信 |
| `VOICE_MODE=bridge` | 言語にかかわらず、返信全文を OpenAI TTS で合成して PCM を送信 |
| `TTS_VOICE` | OpenAI の音声 ID。既定 `coral` |
| `TTS_INSTRUCTIONS` | 任意の話し方指示。例 `Speak calmly and warmly.` |

明示的な device モードで sanoTTS がない場合や日本語以外の場合はエラーになります。
未指定なら自動選択です。端末には `online / device` / `online / bridge` のように表示します。
接続後の設定通知に `voice.mode {mode:"device"|"bridge"}` を使い、発話ごとにも通知します。
端末は実際に再生する音声経路からも表示を更新します。

## Dot の声に合わせる

ChatGPT で Dot と通話して、選択中の声の表示名と話し方を確認してください。
API の候補を試聴して同じ声の ID が選べる場合は、それを `TTS_VOICE` に設定します。
候補は `alloy`, `ash`, `ballad`, `coral`, `echo`, `fable`, `nova`, `onyx`, `sage`,
`shimmer`, `verse`, `marin`, `cedar` です。
ChatGPT の声の表示名と API ID の公式な対応表は確認できていません。
一致する ID がない場合は試聴で近い声を選び、`TTS_INSTRUCTIONS` で口調・速さ・抑揚を
合わせてください。ChatGPT の声設定はこのブリッジに自動同期されず、同一の声を保証しません。
API の声と出力仕様は [OpenAI TTS documentation](https://developers.openai.com/api/docs/guides/text-to-speech)、
ChatGPT での声の選択は [ChatGPT Voice](https://learn.chatgpt.com/docs/features/voice) を参照してください。
生成音声を聞く利用者には AI による音声であることを伝えてください。

キーは AI KeyChain に保存し、ブリッジを起動する子プロセスだけに注入します。
`.env` にキーを書き込まないでください。

```sh
akc set OPENAI_API_KEY
export OPENAI_API_KEY=keychain://OPENAI_API_KEY
export VOICE_MODE=bridge
export TTS_VOICE=coral
export TTS_INSTRUCTIONS='Speak calmly and warmly.'
akc run -- <bridge-command>
```

## Gateway integration

このブランチのブリッジにはまだ WebSocket gateway / Dot アダプタがありません。
音声機能は接続アダプタから呼べる API として実装しています。
`createSpeechQueue(transport, caps, env?)` は初期モード表示を送信してからキューを返します。
transport は以下の契約を満たしてください。

- `sendText(message)` はオブジェクトを JSON にして送信する Promise。
- `sendBinary(frame)` は順序を保って送信する Promise。送信待ちを反映し、切断時には reject。
- `onDone(handler)` は `tts.done` の `seq` と `ok` を通知し、購読解除関数を返す。
- 接続ごとにキューを1個作成し、切断時に `queue.cancel()` を呼ぶ。

```ts
import { createSpeechQueue } from "../bridge/src/index.js";

const queue = await createSpeechQueue(transport, hello.caps);
const receivedAt = performance.now();
await queue.say({ text: replyText, language: "ja", kana: replyKana, receivedAt });
// Interruption / disconnect:
queue.cancel();
```

`Speaker.speak(utterance, signal)` は両モード共通で、端末の `tts.done` まで完了しません。
`SpeechQueue` は合成・転送・再生終了まで1発話がスピーカーを所有する FIFO です。
`cancel()` は待機発話を取り消し、実行中の HTTP request/body を abort して `tts.cancel` を送ります。
失敗・タイムアウトはその発話の Promise を reject し、後続発話へ進みます。
完了待ちには120秒にテキスト長に応じた余裕を加えたタイムアウトがあります。

device モードの `kana` は caller が用意するひらがな中間表現です。
漢字の読み変換は含みません。端末側の4096バイト / 300 ids制限に合わせて発話を分割してください。
bridge モードは元の `text` 全体を使い、`kana` は不要です。
1回の TTS リクエストの入力上限を超える長文は caller で分割してください。

## Streaming and latency

`gpt-4o-mini-tts` の `/v1/audio/speech` を `response_format:"pcm"`,
`stream_format:"audio"` で呼び、HTTP body を到着順に読みます。
24 kHz signed PCM16 LE を32タップ低域 FIR と状態付き2/3変換で16 kHzに変換します。
履歴・位相・奇数バイトの残りをチャンク間で保持するため、HTTPの区切り位置で音が変わりません。

`tts.start` → `[0x02][seq u16 LE][PCM]` → `tts.end` を送ります。
バイナリ全体は4096バイト以下（PCMは最大4092バイト）です。最初の音声フレームは即送信し、
以降は再生時刻より約500 ms以内先行するよう待機して、端末のリング溢れを避けます。
HTTPの長い中断後も先行時間をリセットします。端末で150 ms蓄積してから再生を始めます。

ログ例（テキスト・ホスト名・キーは含みません）:

```text
[tts] first_audio_ms=350.0 target_ms=800 met=true
```

計測開始は `receivedAt`（返信テキスト到着時の `performance.now()`）で、最初の
`sendBinary` が完了した時点までを測ります。省略時は `queue.say` 呼び出し時です。
待機キューの時間も含みます。0.8秒を超えると `met=false` を記録します。
端末で音が聞こえるまでにはジッタバッファ分の遅延も加わります。
実API・ネットワーク・実機で0.8秒目標を満たすかは別途測定が必要です。

端末のリングは再生レートの2秒分をPSRAMに確保し、3個の1024サンプルのバッファを交互に
`M5.Speaker.playRaw` へ送ります。アンダーランでは無音にし、150 msを再蓄積して再開します。
`tts.end` 後は短い残りも流し、リングとスピーカーのキューが空になってから `tts.done` を送ります。
口パクは現在再生中のチャンクの振幅から出します。キャンセルは即座にスピーカーを停止し、
非同期の停止処理がバッファを解放するまでメモリを保持します。

端末へ直接混在して送った `speak.kana` と `tts.*` もFIFOで直列化します。
待機は最大4発話、待機PCMも各2秒分までです。上限超過は `tts.done {ok:false}` になります。
`tts.cancel` は現在の発話と待機発話をまとめて取り消します。
通常のブリッジは `tts.done` を待ってから次を送るため、この上限には達しません。
