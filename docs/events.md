# MCP Events

MCP App は Dot とスタックちゃんをつなぐ既定の経路。ChatGPT の接続アプリで
スタックちゃんをオンにしている間だけ使い、オフにすると切り離せる。
ブリッジ側では、認証の失効を確認した時点で、その購読の配信と再試行を止める。
全体の無効化は `EVENTS_ENABLED=false`、イベント単位の無効化は `EVENTS_SEND` で行う。

実装は [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events)
の MCP `2026-07-28`、Webhook 配信と callback verification に対応する。
ポーリング、ストリーミング、過去イベントの再送は提供しない。

## イベントと設定

| イベント | `data` に含まれる内容 |
|---|---|
| `stackchan.utterance` | `text`（発話全文）、`lang`、`duration_ms`（非負の整数）、任意の `reply_to` |
| `stackchan.touched` | `where`（触れた場所） |
| `stackchan.online_changed` | `online`（接続状態の真偽値） |

購読引数は空のオブジェクト `{}`。接続アカウントに許可されたイベントだけを
`events/list` で返し、各定義に `delivery: ["webhook"]`、`inputSchema`、
`payloadSchema` を含める。

| 環境変数 | 既定値・用途 |
|---|---|
| `EVENTS_ENABLED` | `true`。`false` ならサービス・capability・ハンドラー・発話ソース接続を生成しない |
| `EVENTS_SEND` | 未指定なら3種類すべて。送信を許可するイベント名のカンマ区切り。空文字ならすべて停止 |
| `EVENTS_STORE_DIR` | `.events.local.data`。購読と失敗キューの保存先。既定のディレクトリは Git の無視対象 |
| `EVENTS_SECRET_KEY` | 有効時に必須。32バイトのランダム鍵を標準base64で表したもの。AES-256-GCM の保存暗号化鍵 |

暗号化鍵は Keychain に保管し、実行時だけ注入する。

```sh
export EVENTS_SECRET_KEY=keychain://EVENTS_SECRET_KEY
akc run -- <bridge-command>
```

設定を変更したらサービスを再起動する。独自の保存先はリポジトリの外、または
Git の無視対象に置く。保存ディレクトリの権限は700、JSONファイルは600。
署名鍵、更新前の署名鍵、失敗キューのイベント本文をAES-256-GCMで暗号化する。
所有者識別子、callback URL、イベント名、期限、再試行回数は平文の管理情報として残る。
同じ保存暗号化鍵を維持して再起動すること。鍵の欠落・変更、破損したファイルは
起動エラーにし、購読を暗黙に消して起動しない。

## 統合インターフェース

`bridge/src/events/index.ts` の `createEvents(dependencies, config?)` は
`registrar`、`dispatcher`、`close()` を返す。設定を省略すると環境変数を読む。
統合側で `createMcpServer(toolDependencies, events.registrar)` を呼ぶと、
ツールと同じ `/mcp` に3つのイベントメソッドを登録し、`server/discover` に
`events: {}` を公開する。

必要な依存は以下のとおり。

- `authorizePrincipal(context, { operation, name?, arguments? })` は検証済みの認証情報から
  安定した所有者IDを返す。未認証・不許可なら `null`。所有者をリクエスト引数や
  未検証のトークンから決めない。`operation` は `list`、`subscribe`、`unsubscribe`。
- `recheckAccess(principalId, name, arguments)` は現在も接続・イベントアクセスが
  有効かを返す。認証・接続アプリの管理層で実装し、購読作成時と各配信・再試行前に呼ぶ。
  `false` ならその購読と失敗キューを削除する。
- `source.subscribe(callback)` はデバイス・音声認識側で実装し、
  `{ name, data, timestamp? }` を渡す。戻り値は購読解除関数。認識が完了した発話を
  一度だけ通知し、`listen` や音声再生を経由して同じ発話を再通知しない。
  #16 の「通知後10秒以内の返事」の `reply_to` は、このアダプターから渡す。
- `timestamp` は発生時刻のタイムゾーン付きISO 8601文字列。省略すると受信時刻を使う。
  `post`、`now` はテスト用の差し替え口。通常は既定の安全なHTTPS転送を使う。
  `onError` は本文やURLを含まない診断カテゴリだけを受け取る。

認証層とデバイス層の実装・エントリーポイントへの結線は各担当issueで行う。
停止時は `await events.close()`、続けて `await server.close()` を呼ぶ。
実行中のHTTPSリクエストは完了する可能性があるが、以後の配信と再試行は停止する。

## 購読・配信の契約

`events/subscribe` の入力は次の形。

```json
{
  "name": "stackchan.utterance",
  "arguments": {},
  "delivery": {
    "mode": "webhook",
    "url": "https://receiver.example.com/callback",
    "secret": "whsec_<base64-encoded-signing-key>"
  },
  "cursor": null,
  "ttlMs": 86400000
}
```

署名鍵は接続先から渡される24〜64バイトのbase64鍵。購読IDは、認証された所有者・
URL・イベント名・canonical JSONの引数から決定する。同じ組み合わせなら更新し、
重複購読を作らない。結果は `{ id, refreshBefore, cursor: null, truncated: false }`。
期限は既定・上限とも24時間。指定された `ttlMs` より長い期限は与えない。
`ttlMs: null` の無期限要求にも有限の24時間を返す。期限を過ぎた購読は配信しない。

新しいcallbackには、署名付きの `{ type: "verification", challenge }` を先に送る。
10秒以内の2xx応答と同じchallengeが必要で、比較は定数時間で行う。成功した検証を
所有者・URL単位で5分間キャッシュし、再起動後の購読更新では再検証する。失敗はJSON-RPC
`-32015` と `data.reason`（`challenge_failed`、`timeout`、`redirect`、
`non_public_address` など）で返す。

検証・配信ともHTTPSのみ。接続時にDNSの全回答を検査し、非公開・予約・
ループバック・リンクローカル・CGNAT・IPv6移行用アドレスを拒否する。
接続は検査済みIPに固定し、TLS証明書の検査とSNIには元のホスト名を使う。
接続の再利用とリダイレクト追従は行わず、再試行時もDNSを引き直す。

アプリケーションイベントは1リクエストに1件、全体で262,144バイト以下。
`{ eventId, name, timestamp, data, cursor: null }` を一度だけJSON化し、そのバイト列を
`standardwebhooks` で署名して送る。ヘッダーは `Content-Type: application/json`、
`webhook-id`（`eventId`と同じ値）、`webhook-timestamp`（署名時のUnix秒）、
`webhook-signature`、`X-MCP-Subscription-Id`。署名鍵の更新後5分間は新旧両方の
Standard Webhooks署名を空白区切りで送る。

一時的な接続失敗、408、429、5xxは、初回に加えて最大5回、1・2・4・8・16秒の
間隔で再試行する。本文と`eventId`は維持し、署名時刻と署名を作り直す。
410は購読とキューを削除。413、その他の恒久的な4xx、リダイレクト、非公開の
接続先は再試行しない。成功・恒久失敗・再試行上限到達で失敗キューから削除する。
失敗キューは再起動後も回数と予定時刻を引き継ぐ。初回送信前のイベントはメモリに
あり、停止中のイベントは復元しない。順番は保証されない。

`events/unsubscribe` は元の `name`、`arguments`、`delivery: { mode: "webhook", url }`
で指定し、空の結果 `{}` を返す。所有者ごとに解除し、繰り返しても成功する。
SDKが付ける`_meta`は通常のMCPメタデータとして結果に付随する。

受け手は`eventId`で重複を処理し、タスクが書き込みを行う場合は、その書き込みも
冪等にすること。既存の`say`と`notify`は呼び出しごとに実行するため、イベントの
再処理で二重に呼ばないように統合側で扱う。

## 検証と実機確認

`npm run check` は偽の受け手でverification→配信→公式ライブラリの署名検証→410停止、
再試行、解除、期限、アクセス失効、再起動、DNS検査と接続先固定を確認する。
偽の受け手は`post`を注入し、ローカルHTTPSを本番の接続先検査に特別許可しない。
MCPのテストは実際のHTTP応答でdiscoveryと3メソッドの形を確認する。

認証・発話アダプターが結線された後、ChatGPTでイベントを再スキャンし、Workの
CloudチャットまたはDotで「発話イベントを受けたら`say`で短く返事する」購読を設定する。
合成のテスト文で発話→通知→`say`→実機の音声を確認し、監視解除・接続アプリの
オフ・ブリッジ再起動でも確認する。E2E動画・設定画面・送信ログは
[privacy.md](privacy.md)に従って個人情報を隠す。
