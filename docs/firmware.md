# CoreS3 / K151 firmware

PlatformIO の `m5stack-cores3` 環境を使います。CoreS3 の 16 MB Flash / 8 MB OPI
PSRAM を有効にし、顔・音声・シリアル・ネットワークを独立したモジュールで処理します。
CoreS3 内蔵マイクからの押して話す音声入力に対応します。カメラ・Module-LLM は含みません。

## Build and install

```sh
npm ci
npm run check
pio run -d firmware
bash scripts/test-firmware-host.sh
```

Node.js 22 以上、C/C++ コンパイラ、PlatformIO が必要です。ホスト結合テストには
`pkg-config` と OpenSSL の開発用ライブラリも必要です。ホストテストは実際の
protocol / mic / player / ws_link を、仮想のブリッジ・マイク・スピーカーにつないで検証します。
ホスト結合テストは sanoTTS 無効・有効・VAD 有効の3構成で実行します。
TLS のハンドシェイクと実際の WebSocket 転送はモックのため実機で別途確認してください。

実機を接続した人が書き込む場合だけ、次のコマンドを実行します。

```sh
pio run -d firmware -t upload
pio device monitor -d firmware
```

## Serial setup

115200 baud、改行でコマンドを送ります。入力はエコーせず、保存結果だけを表示します。
端末側のローカルエコーとログ保存も無効にしてください。Wi-Fi、サーバー、PSK、NTP
の既定値は空です。デバイス ID は初回にチップ ID から生成して NVS に保存します。

```text
wifi:<ssid>:<password>
server:wss://<your-host>/device
psk:<hex-psk>
ntp:<your-ntp-host>
status
reboot
```

`psk` は 16〜128 文字の偶数長の hex 文字列です。HMAC のキーは**この文字列の
UTF-8 バイト列**で、hex デコードはしません。ブリッジにも同一の文字列を設定します。
HTTP ヘッダーは `X-Device-Id` / `X-Timestamp`（Unix 秒）/ `X-Auth`。
署名は `hex(HMAC-SHA256(psk, deviceId + ":" + timestamp))` です。
認証時刻はブリッジから ±60 秒以内である必要があります。

TLS 検証と認証には正しい時刻が必要です。`ntp:` のサーバーを設定して再起動すると
SNTP で同期します。同期前は WebSocket 接続を待ち、後で自動的に再試行します。
NTP を使えない環境では、再起動ごとに現在の値を `time:<unix-seconds>` で送ってください。
`status` は `clock=ready` / `unset` を表示します。時刻は NVS に保存しません。

追加のコマンド:

| Command | Behavior |
|---|---|
| `wifi-list` | 保存件数だけを表示（最大 5 件。同じ SSID は更新、満杯なら最古を置換） |
| `wifi-clear` | 全 Wi-Fi 設定を削除 |
| `device:<id>` | 英数字・`-`・`_` の ID（最大 64 文字）を保存 |
| `servo:<pan-id>:<tilt-id>:<tx-pin>:<rx-pin>` | サーボ設定を NVS に保存 |
| `status` | 値を `<set>` / `<unset>` に伏せて状態を表示 |
| `reboot` | 保存済み設定を読み直して再接続 |
| `credits:on` / `credits:off` | 帰属表示を開く／閉じる（再起動不要） |

`time:` 以外の変更は再起動で適用します。SSID に `:` がある場合はこの CLI の
区切り形式では設定できません。Wi-Fi のパスワードは最初の区切り以降をそのまま保存します。
NVS は通常の Preferences 保存で、この実装は NVS 暗号化を設定しません。

## Protocol v1

経路は `/device`。`wss://`（既定 443）と開発用 `ws://`（既定 80）を使えます。
明示ポートも指定できます。IPv6 リテラルは未対応なので DNS 名を使ってください。
Wi-Fi は保存したプロファイルを巡回し、WebSocket は 5 秒間隔で再接続します。
再接続の認証ヘッダーは毎回更新します。ping/pong ハートビートも有効です。
画面には `online` / `offline` と `device` / `bridge` の音声モードを表示し、接続ごとに `hello` と `state` を送信します。

| Bridge → device | Fields |
|---|---|
| `welcome` | `session`, `server_time` |
| `voice.mode` | `mode`: device / bridge（接続後のモード表示通知） |
| `face` | `expression`: neutral / happy / sad / doubt / sleepy / angry |
| `look` | `pan`, `tilt`（度。±90 / ±30 に丸める） |
| `speak.kana` | `seq`（0〜65535）, `kana`, optional `expression` |
| `tts.start` | `seq`, `sample_rate`（8000〜48000）, `channels:1`, `bits:16` |
| `tts.end` | `seq` |
| `tts.cancel` | 発話の受信・合成・再生を中止 |
| `chime` | `kind:"notify"` |
| `ping` / `pong` | `t` |

バイナリは `[kind u8][seq u16 LE][PCM]`、全体が 4096 バイト以下。
TTS の kind は `0x02`、PCM は little endian signed 16 bit mono です。
PCM は PSRAM の2秒分のリングに受信し、約150 ms蓄積したら `tts.end` を待たず再生します。
3個の1024サンプルの再生バッファを使い、アンダーラン時は無音にして再蓄積後に再開します。
`tts.end` 後は短い残りも再生し、リングと再生キューが空になってから完了を通知します。
口パクは再生中のチャンクの振幅から出します。
`speak.kana` とPCMは到着順に直列化し、前の発話を中止しません。
待機は最大4発話、待機PCMは各2秒分まで。上限超過は失敗として通知します。
不明なシーケンスのフレームは破棄します。`tts.cancel` は現在と待機発話をまとめて中止します。
完了・失敗・キャンセルは `tts.done {seq,ok}` で通知します。
合成タスクがキャンセル後の片付け中の場合、新しい発話は安全に解放されるまで待機します。未知・不正な JSON は破棄します。

画面または BtnA を押している間だけ録音し、離すと認識待ちになります。
複数の指や BtnA が同時に押されている場合は、すべて離した時点で終了します。
15 秒で終了した後は、いったん離して押し直すまで録音を再開しません。
BtnB/C は `event {kind:"button",where:"B"}` などを送ります。
PTT のタッチ／BtnA は通常の `event` を送信しません。
BtnB 長押しでクレジットを切り替え、8 秒ごとに全帰属表示をページ送りします。
BtnB が利用できない CoreS3 ではシリアルの `credits:on` / `credits:off` を使えます。
クレジット表示中の画面タッチ／BtnA は顔へ戻して録音します。
状態は idle / listening / thinking / speaking / notifying を画面表示・自動送信します。
再生中の PCM 振幅から口パクします。

## Push-to-talk microphone

開始は `mic.start {seq,sample_rate:16000}`。16 kHz / signed PCM16 LE / mono、
320 サンプル（20 ms）ごとに kind `0x01` のバイナリを送ります。
1 フレームはヘッダー込み **643 bytes**。まとめ送信による待ち時間を加えず、
録音中から逐次認識へ流せます。seq は発話ごとに増やし、65535 の次は 0 です。
最後の送信済み PCM の後に `mic.end {seq,reason:"release"}`、
15 秒上限は `reason:"timeout"` を1回送ります。顔は録音中 `listening`、
終了後は発話開始まで `thinking` です。接続していない間は録音しません。

M5Unified **0.2.24 以降**のバッファ解放コールバックと2個の録音バッファで、
次の録音を先にキューしておきます。録音の20 ms周期は I2S のサンプルクロックで決まり、
`loop()` の描画や通信時間に依存しません。専用タスクが開始・終了・15秒の監視を担い、
別の TX タスクが WSS へ送ります。WebSocketsClient の操作は再帰ミューテックスで直列化します。
送信待ちは **32 フレーム / 640 ms / 20576 bytes** まで。
待ち行列の満杯や録音・タスク作成の失敗では `timeout` で終了し、途中の PCM を黙って間引きません。
切断・送信失敗時は録音を中止して未送信データを捨て、再接続後に古い発話を送りません。
音声は RAM のみに置き、ディスク／Flash に保存せず、音声内容をログへ出しません。

PCM、sanoTTS、合図音、通常の音声経路を使うフィラーは録音と排他です。
発話中の PTT は待機発話と再生を中止し、`tts.done` を送信せず録音へ切り替えます。
録音中に届く発話は既存の最大4件の待ち行列で保留し、合図音は1件にまとめて保留します。
CoreS3 の共有 I2S / codec は、録音前に `Speaker.stop()` / `Speaker.end()`、
録音タスク終了時に `Mic.end()`、送信完了後に `Speaker.begin()` の順に切り替えます。
合成中の sanoTTS はタスクの終了と PCM 解放を待ってから録音します。
切替手順は公式 [M5Unified Microphone example](https://github.com/m5stack/M5Unified/blob/0.2.24/examples/Basic/Microphone/Microphone.ino)
と [Mic_Class API](https://github.com/m5stack/M5Unified/blob/0.2.24/src/utility/Mic_Class.hpp) に沿っています。

任意の簡易 VAD は `platformio.ini` の `build_flags` に `-DDOTS_MIC_VAD=1` を
追加して有効にします（既定は無効）。ピーク振幅1000以上のフレームを検出した後、
800 ms の無音で `reason:"vad"` を送ります。無音だけでは15秒上限まで継続します。
振幅のしきい値はマイクの感度や環境音に依存するため実機で調整してください。

## TLS

`DOTS_TLS_VERIFY=1` が既定で、公式 [ISRG Root X1](https://letsencrypt.org/certificates/)
を同梱しています。ホスト名・有効期限・CA チェーンを ESP32 の TLS クライアントで検証します。
Let's Encrypt の Root X1 に連なる Tailscale Funnel の URL を `server:` に設定してください。
自己署名証明書などを開発環境で使う場合のみ、`platformio.ini` の
`-DDOTS_TLS_VERIFY=0` に切り替えられます。そのビルドの WSS は証明書を検証しません。

## K151 servo wiring

K151 の SCS0009 は UART1、1 Mbps、TX GPIO6 / RX GPIO7、pan ID1 / tilt ID2。
PWM サーボではありません。K151 の内蔵配線を使用し、PY32 I/O エクスパンダ
（内部 I2C の `0x6f`、pin0）でサーボ電源を有効にします。
GPIO、ID は NVS または `DOTS_SERVO_{PAN_ID,TILT_ID,TX_PIN,RX_PIN}` のビルド定義で変更できます。
公式 [hal_servo.cpp](https://github.com/m5stack/StackChan/blob/main/firmware/main/hal/hal_servo.cpp)
の基準位置は pan 460 / tilt 620、1 step = 0.3125° です。プロトコルの tilt 0° は
物理角 45°（raw 764）の中立姿勢に対応し、±30° は物理角 15〜75° に収めます。
raw 値は 0〜1000 に制限し、移動時間は 250 ms。SCS0009 のワードは big endian です。
同梱の FTServo コードは使わず、小さな位置書き込みパケットを自前で生成します。

## sanoTTS

MIT の推論コアだけを同梱し、重みは gitignore しています。
[PROVENANCE](../firmware/lib/sanotts/PROVENANCE.md) にコミットとコピー元を記録しています。
モデルのライセンスと原文の帰属表示は [NOTICE](../firmware/lib/sanotts/NOTICE.md) と
[README](../README.md#license)、画面クレジットにあります。

```sh
bash firmware/scripts/fetch-sanotts-model.sh
pio run -d firmware
DOTS_SANOTTS=0 pio run -d firmware
```

[v0.3.1 release](https://github.com/ayutaz/sanoTTS-jp/releases/tag/v0.3.1) の
`saanotts-jp-v3-int8.bin`（blob **v2**、654032 bytes）を取得し、SHA-256
`2d2b8543c06b6a749f19c9918de68244409e2bb6ad1d921a90b5c358f96d4d79` を検証します。
ビルド時も SHA-256 と形式を検証します。重みがない場合や `DOTS_SANOTTS=0` 指定では
sanoTTS を除外し、`hello.caps.sanotts=false`、`speak.kana` には `tts.done {ok:false}`。
ブリッジの自動選択では OpenAI TTS の PCM 経路を使います。
`VOICE_MODE` / `TTS_VOICE` / `TTS_INSTRUCTIONS` と接続APIは [音声モード](tts.md) を参照してください。

取得不能の場合は upstream の `a478680073aacfec4fc16c31e370d63ef09c8d14` を別の
チェックアウトで用意し、v0.2.0 の `saanotts-jp-v3-stage4.pt` から生成します。
上流の Python 環境をセットアップして、次を実行します。

```sh
uv sync
uv run python scripts/export_c_weights.py --ckpt saanotts-jp-v3-stage4.pt \
  --out csrc/saanotts-jp-v3-int8.bin --int8
```

生成物も上のハッシュと照合して `firmware/lib/sanotts/model/` に置きます。
v0.2.0 リリースの int8 blob v1 はこのコアでは使えません。

`kana` は上流 G2P の**ひらがな中間表現**（例 `こんにちわ`、アクセントマーク `[` / `]`
など）を渡します。漢字を読みへ変換する処理は含まれません。
入力は最大 4096 バイト、G2P は最大 300 ids。長い発話はブリッジで分割してください。
合成タスクは core0、176 KiB arena（内部 RAM を優先し、不足時は PSRAM）を使います。
3 倍ゲインとソフトクリップを適用し、実測速度に 15% の余裕を加えて再生開始を決定します。
再生は生成済みの PCM だけをスピーカーへキューするため、速度が落ちても未生成領域を読みません。
シリアルには `[sanotts] playback after ... ms` を表示します。この値は再生キューを始めた時点で、
実際に音が聞こえるまでの遅延とは少し異なります。

## Hardware checks still required

この issue の開発環境には実機がありません。次を K151 と #4 のブリッジで確認します。

1. シリアル設定→再起動→Wi-Fi 接続・認証・online 表示。Wi-Fi とブリッジを止め、復帰後の再接続。
2. 有効な Funnel 証明書で接続し、不正な証明書・ホスト名・時刻では接続が拒否されること。
3. 全 6 表情と `look` の中央・境界・範囲外。中立姿勢と機械的な安全域も確認。
4. PCMが `tts.end` 前に鳴ること、口パク、`tts.done`、再生中の `tts.cancel`。
   ストリームを一時停止してアンダーランと再開を確認し、2秒以上の長い発話も再生する。
   両モードの混在と画面表示、chime、BtnB/C の `event`。
   bridgeモードで返信到着→最初のPCM送信が **0.8秒以内**かログを計測する。
5. `speak.kana` の音・合成中の表情と口パク。受信から発声まで **0.6 秒以内**か計測。
   発話長・arena 配置・TLS のメモリ使用量に依存するため、このビルドだけでは時間を保証できません。
6. BtnB 長押しで全クレジットが読めること。背景に部屋や人を含めず短い動画を撮り、共有ログを伏せ字にする。
7. 画面／BtnA の PTT、複数指とボタンの併用、離すと終了、15秒で1回終了すること。
   PCM・sanoTTS・chime・フィラーを PTT で中止し、自分の声を録音しないこと。
   録音中に届いた発話は録音終了後に再生し、切断後に古い PCM が送られないこと。
   合成音声を聞かせて「スタックちゃん」を含む文字起こしと終了から確定まで0.6秒以内を
   #6 のブリッジと合わせて計測する。ホストテストは実機の I2S / TLS の時間を再現しません。

移植したのは公開 sanoTTS 推論コアの 14 ファイルとその MIT LICENSE / 原文帰属表示。
非公開プロジェクトからファイルをコピーしていません。Wi-Fi の NVS 保存、HMAC ヘッダー、
PCM 再生、K151 の電源と位置変換、sanoTTS の再生開始判定は参考にして再実装し、
ホスト名・SSID・秘密値の既定値は一切取り込みませんでした。

話し終わりの相槌キャッシュ・接続時の合成・設定・実機計測は [fillers.md](fillers.md) を参照する。
