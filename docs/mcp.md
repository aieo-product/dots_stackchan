# MCP サーバー

スタックちゃんの音声、表情、首、マイクを MCP ツールとして公開する。エンドポイントは Streamable HTTP の `/mcp` で、MCP `2026-07-28` と旧来の `initialize` 接続の両方を受け付ける。

## 接続の扱い

MCP App は Dot とスタックちゃんをつなぐ既定の経路である。ChatGPT の接続アプリでスタックちゃんをオンにしている間だけ Dot がこれらのツールを使える。接続アプリをオフにすると、Dot からスタックちゃんをすぐ切り離せる。

認証と公開 HTTPS は別 issue で追加する。それまでは `MCP_HOST=127.0.0.1` のみを利用し、LAN やインターネットへ公開しないこと。`bridge/src/mcp/config.ts` の設定スキーマもループバック以外を拒否する。

統合側は `createMcpServer({ device, speaker, listener })` を生成し、`await server.listen(port, host)` で起動する。`device`、`speaker`、`listener` はそれぞれ DeviceLink、Speaker、Listener インターフェースを実装する。終了時は `await server.close()` を呼ぶ。

`Speaker.say(text, { expression?, interrupt? })` は同期的にキューへ追加し、`SpeechTicket { id, estimatedSeconds, done }` を即返す。`estimatedSeconds` は日本語の文字数 × 0.15秒程度の概算で、`done` はデバイスの `tts.done` 成功報告で解決し、失敗・キャンセルで拒否する。`Speaker.cancelAll()` は戻り値なしで全発話をキャンセルする。

## ツール

| ツール | 入力 | 動作 | 注釈 |
|---|---|---|---|
| `say` | `text`、任意の `expression` / `interrupt` / `wait` | SpeechQueue に追加し、既定の `wait=false` では概算秒数付きの受付結果を即返す。`wait=true` は完了を最大60秒待ち、未完了なら「still speaking」を返す。表情は発話前に適用する | 書き込み、非破壊、非冪等 |
| `set_expression` | `expression` | 表情を変更する | 書き込み、非破壊、冪等 |
| `look` | `pan`（-90〜90）、`tilt`（-30〜30） | 首を指定角度へ向ける | 書き込み、非破壊、冪等 |
| `notify` | `message`、任意の `priority` / `topic_id` | チャイムを送信して通知をキューへ追加し、再生完了を待たず即返す。指定された `topic_id` を結果に含める。`high` は現在の発話を中断する | 書き込み、非破壊、非冪等 |
| `get_status` | なし | `online`、`speaking`、`listening`、`last_utterance_seconds_ago` を返す | 読み取り、冪等 |
| `listen` | 任意の `timeout_s`（1〜120、既定30） | 次の発話を1回待ち、文字列またはタイムアウトを返す | 読み取り、非冪等 |

`expression` は `neutral`、`happy`、`sad`、`doubt`、`sleepy`、`angry` のいずれかである。入力範囲外、未知の表情、オフライン、対応していないマイクやサーボは `isError: true` のツール結果になる。

`say` と `notify` はそれぞれ独立して、既定で直近1分あたり20回まで呼び出せる。通知の重複除去と静かにする時間帯はこの段階では扱わない。

受付結果は再生成功の確認ではない。受付後に起きた失敗・キャンセルは即時応答には反映されず、`say` の `wait=true` で待機中に発生した場合は `isError: true` を返す。60秒で待機を終えても発話は継続する。

## MCP Inspector で確認する

ブリッジ統合から MCP サーバーを起動した状態で、Web UI を開く。

```sh
npx @modelcontextprotocol/inspector --web \
  --server-url http://127.0.0.1:<mcp-port>/mcp \
  --transport http \
  --protocol-era auto
```

Tools 画面で6ツールと入力スキーマを確認する。実機確認では、まず `get_status`、次に `set_expression` と小さい角度の `look`、短い `say`、`listen` の順に試す。

CLI だけで一覧を見る場合:

```sh
npx @modelcontextprotocol/inspector --cli \
  --server-url http://127.0.0.1:<mcp-port>/mcp \
  --transport http \
  --protocol-era auto \
  --method tools/list
```

実機を使う確認では、ツールの実行結果に加えて、表情・首・音声が反映されたことを目視する。自動テストは偽デバイスを使うため、実機のサーボ方向、音量、マイク認識までは保証しない。
