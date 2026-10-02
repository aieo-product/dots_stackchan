# MCP 公開と認証

MCP 用 HTTP リスナーだけを Tailscale Funnel のルートに割り当てる。既定の HTTPS ポートは 8443、選択可能なポートは 443 / 8443 / 10000。公開されるのは `/mcp`、OAuth、discovery のみである。`/device` はこのリスナーで常に 404 にし、PSK-HMAC のデバイスゲートウェイは LAN / tailnet に置く。公開するポートにデバイスゲートウェイを同居させない。

## OAuth の境界

`createOAuth(config, options?)` と `wrapMcpHandler(oauth, handler)` を `bridge/src/oauth/index.ts` からエクスポートする。`createMcpServer(dependencies, { oauth })` も同じラッパーを利用する。`bridge/src/index.ts` と既存の設定・デバイス統合への配線は後続の統合作業で行う。OAuth を省略した既存 API はローカル開発用なので、そのリスナーを公開しない。Funnel スクリプトの `up` は 401 と discovery、および `/device` の 404 を確認してから公開する。

公開 URL は `MCP_PUBLIC_URL=https://<your-host>.<your-tailnet>.ts.net:8443/mcp` のように環境変数で渡す。HTTPS の `/mcp` まで含む正規 URL とし、クエリー・fragment・ユーザー情報を付けない。issuer はその origin、resource は `/mcp` を含む URL で、転送された Host / Forwarded ヘッダーから生成しない。

実装のプロトコルは [MCP Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)、[RFC 9728](https://www.rfc-editor.org/rfc/rfc9728)、[RFC 8414](https://www.rfc-editor.org/rfc/rfc8414)、[RFC 7591](https://www.rfc-editor.org/rfc/rfc7591)、[RFC 7636](https://www.rfc-editor.org/rfc/rfc7636)、[RFC 8707](https://www.rfc-editor.org/rfc/rfc8707)、[RFC 9700](https://www.rfc-editor.org/rfc/rfc9700) に基づく。

| 項目 | 実装 |
|---|---|
| discovery | `/.well-known/oauth-protected-resource/mcp` とルート版、`/.well-known/oauth-authorization-server` |
| 未認証 MCP | 401、`WWW-Authenticate: Bearer resource_metadata="…", scope="stackchan"`。無効・期限切れなら `error="invalid_token"` |
| DCR | `POST /oauth/register`、公開クライアント `none`、HTTPS の登録済み redirect のみ、最大100件。省略した grant は `authorization_code` |
| authorize | GET で同意画面、POST で明示的な許可 / 拒否。S256 のみ、redirect 完全一致、resource 必須、state を返す。issuer も `iss` で返す |
| scope | `stackchan` の1種類。音声、表情、首、通知、状態取得、マイクの6ツールへの権限を同意画面で説明する |
| code | 256 bit の不透明乱数、5分、1回だけ交換可。交換後1時間はハッシュを保持し、コードの再利用を検知したら、そのトークン系列を取り消す |
| access token | 256 bit の不透明乱数、1時間。毎リクエスト Bearer ヘッダーのみで確認、resource を照合。URL 中の access_token は拒否 |
| refresh token | DCR で `refresh_token` を要求したクライアントだけに発行。毎回入れ替え、使用済みトークンの再利用を検知したら系列全体を取り消す。最初の発行から30日で期限切れ |

ブラウザーの同意要求は10分間有効な使い捨て乱数と、Secure / HttpOnly / SameSite=Lax の `__Host-` cookie に束縛する。POST は設定された issuer と完全一致する Origin が必要で、フォームから client / redirect / PKCE の上書きは受け付けない。並行する別タブで同意画面を開くと cookie が置き換わるため、最初のタブは開き直す。間違えたパスコードも要求を消費するので、再試行は GET から行う。

同意画面は外部画像・フォント・スクリプトを使わず、HTML エスケープ、CSP (`frame-ancestors 'none'`)、no-store、no-referrer を付ける。登録されたクライアント名は本人確認ではない。画面に表示された返り先とクライアントを確認し、身に覚えのない同意画面へパスコードを入力しない。

## 保存とログ

`MCP_PASSCODE` は Keychain に保管し、`keychain://MCP_PASSCODE` を `akc run` で解決してプロセスに注入する。16〜1024 byte の十分ランダムな値を使い、`.env`、引数、ソース、ログへ実値を書かない。起動時にランダム salt 付き scrypt ハッシュへ変換し、比較は `node:crypto` の `timingSafeEqual` で行う。

クライアント ID、同意要求、cookie、code、access / refresh token は SHA-256 ハッシュだけを保存する。クライアントの表示名・redirect URI・resource・未完了要求の state は保存されるため、ストアも私的な運用データとして扱う。`OAUTH_STORE_DIR` は専用の絶対ディレクトリを環境変数で指定できる。既定は macOS のユーザー Application Support、Linux の XDG data、Windows の LocalAppData 内である。ディレクトリは 0700、`store.json` は 0600。所有者・権限・schema・resource を検証し、破損したストアから新規セッションを作って復旧することはしない。

保存は同じディレクトリの一時ファイルへの書き込み、fsync、原子的 rename、ディレクトリ fsync の順で行う。トランザクションの排他ロックを使い、競合時は失敗させる。通常は1プロセスで運用する。クラッシュ後に `transaction.lock` が残った場合は、ブリッジを停止し、他の書き手がいないことを確認してからそのロックだけを削除する。ロックを自動的に奪うことはしない。

アクセスログは固定ラベルの route / method と status だけ。IP、Host、クエリー、本文、Authorization、Cookie、client ID、パスコード、PSK はロガーに渡さない。リバースプロキシや別のログ機構も本文・ヘッダー・URL クエリーを記録しない設定にする。

## 脅威と運用

| 脅威 | 対策・限界 |
|---|---|
| 公開 URL の漏えい | URL は秘密の認証情報として扱わない。OAuth で MCP を守り、デバイス入口を非公開にする |
| パスコードの総当たり | 15分の窓内でクライアント単位と全体の失敗を数える。どちらかが5回に達すると最後の失敗から15分間、正しいパスコードでも拒否する。再起動や別の DCR 登録で全体ブロックを回避できない |
| トークン盗難 | HTTPS、短い access 寿命、resource 束縛、refresh rotation と再利用検知。Bearer なので、盗まれた現在の access token は期限切れ・取り消しまで使われ得る |
| 認可コード横取り / オープンリダイレクト | S256 PKCE、redirect の登録と完全一致、resource / client の照合、使い捨て code、ブラウザーに束縛した同意、state / issuer の往復 |
| DCR・同意要求による資源枯渇 | 登録100件、未完了同意256件、code256件、access / refresh 各4096件、OAuth 本文8 KiB、HTTP 本文64 KiBまで。期限切れは認可・トークン処理時に整理。公開 DCR や全体ブロックはサービス妨害に使われ得るため、不要時は Funnel を閉じる |
| 同じホストの別サービスへの影響 | 選択ポートだけを操作し、競合する設定は拒否する。他ポートを消す reset は使わない |
| ローカルユーザーの侵害 | Keychain と私的なストア権限で保護。同じ OS ユーザーで動く悪意あるプロセスやホスト侵害はこの最小認可サーバーの信頼境界外 |

取り消す場合はブリッジを停止して、ビルド済みのリポジトリで実行する。

```sh
npx --no-install dots-stackchan revoke
```

同じ `OAUTH_STORE_DIR` を指定する。登録クライアント、同意要求、code、access / refresh token を全て取り消す。ロックアウトの記録は残す。再接続には DCR と同意が必要で、パスコードだけを変更しても既存 token は取り消されない。取り消し後は新しい `MCP_PUBLIC_URL` にストアを束縛し直せる。緊急時はまず `bash scripts/funnel.sh down --port 8443` で公開を閉じる。

Funnel の CLI と利用条件は [Tailscale Funnel](https://tailscale.com/docs/reference/tailscale-cli/funnel) を参照する。`--bg` の公開は再起動後にも継続する。`status` の出力はホスト名を伏せる。up / down の CLI 出力も抑止して、私的な DNS 名をログに残さない。

## 検証範囲

自動テストは不正 redirect、PKCE、resource、CSRF、重複パラメータ、code 再利用、期限切れ、refresh rotation / 再利用、ストア権限・破損、取り消し、全体ロックアウト、ログの秘匿を確認する。SDK の標準 OAuth による discovery → DCR → 同意 → token → 実 HTTP リスナーの MCP ツール呼び出しも通す。テストでは公開 HTTPS URL をループバックに写像し、Funnel の設定や実際の TLS 終端は変更しない。

ChatGPT のアプリ登録、実際の Funnel の HTTPS 到達性、デバイスの PSK-HMAC・音声・サーボは統合後に利用者が確認する。認証なしの公開はサポートしない。証跡のホスト名、アカウント名、コード、token は公開前に伏せる。
