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
| DCR | `POST /oauth/register`、公開クライアント `none`、許可 origin の HTTPS redirect のみ、最大100件。未使用登録は1時間で削除、満杯なら最古の未使用登録を優先退避。省略した grant は `authorization_code` |
| authorize | GET で同意画面、POST で明示的な許可 / 拒否。S256 のみ、redirect 完全一致、resource 必須、state を返す。issuer も `iss` で返す |
| scope | `stackchan` の1種類。音声、表情、首、通知、状態取得、マイクの6ツールへの権限を同意画面で説明する |
| code | 256 bit の不透明乱数、5分、1回だけ交換可。交換後1時間はハッシュを保持し、コードの再利用を検知したら、そのトークン系列を取り消す |
| access token | 256 bit の不透明乱数、1時間。毎リクエスト Bearer ヘッダーのみで確認、resource を照合。URL 中の access_token は拒否 |
| refresh token | DCR で `refresh_token` を要求したクライアントだけに発行。毎回入れ替え。直前のトークンだけ、交換から10秒未満の再送に同じ新ペアを返す（残り access 寿命を返す）。それ以外の再利用は系列全体を取り消す。最初の発行から30日で期限切れ |

ブラウザーの同意要求は10分間有効な使い捨て乱数と、Secure / HttpOnly / SameSite=Lax の `__Host-` cookie に束縛する。POST は設定された issuer と完全一致する Origin が必要で、フォームから client / redirect / PKCE の上書きは受け付けない。並行する別タブで同意画面を開くと cookie が置き換わるため、最初のタブは開き直す。間違えたパスコードも要求を消費するので、再試行は GET から行う。

同意画面は外部画像・フォント・スクリプトを使わず、HTML エスケープ、CSP (`frame-ancestors 'none'`)、no-store、`Referrer-Policy: same-origin` を付ける。これにより同意フォームの POST が正しい Origin を送る。`Origin: null` は許可しない。303 の返り先への転送には `no-referrer` を付ける。表示名は120文字までで、制御文字・bidi を含む不可視書式文字を拒否する。返り先 URL と設定 origin にも同じ文字チェックを適用し、同意画面には redirect origin を太字で表示する。登録されたクライアント名は本人確認ではない。画面に表示された返り先とクライアントを確認し、身に覚えのない同意画面へパスコードを入力しない。

`OAUTH_ALLOWED_REDIRECT_ORIGINS` はカンマ区切りの HTTPS origin（パスなし）で、既定は `https://chatgpt.com`。追加のクライアントを使う場合だけ、信頼する origin を明示する（例: `https://chatgpt.com,https://example.org`）。登録に1件でも許可外 URI が含まれると `400 invalid_redirect_uri`。許可設定の変更後に残った登録にも認可時に再確認し、許可外の origin への成功・エラー転送は行わず HTML エラーを表示する（[RFC 9700 §4.11.2](https://www.rfc-editor.org/rfc/rfc9700.html#section-4.11.2)）。認可途中の拒否 POST にも同じ制限を適用する。

[OpenAI公式資料の Redirect URL](https://developers.openai.com/plugins/build/auth#redirect-url)（2026-10-02確認）では、RFC 9207 issuer 識別対応時の正確な ChatGPT URI は `https://chatgpt.com/connector_platform_oauth_redirect`、非対応時は `https://chatgpt.com/connector/oauth/{callback_id}`。この実装は issuer 対応で、どちらも既定 origin に入る。ChatGPT の管理画面に出る正確な URI で登録し、認可・交換時は登録 URI との完全一致を維持する。origin の許可は URL パスのワイルドカード登録を意味しない。

未使用とは一度もトークンを取得していない登録を指す。トークンを取得済みの登録は期限切れ・退避対象にしない。既存ストアに登録日時や使用フラグがない場合は、保存済み token / 交換済み code の証跡があるクライアントを使用済みに移行し、それ以外は次の整理で削除する。削除された既存登録は DCR からやり直す。使用済み登録だけで100件に達すると429になり、運用者が取り消しを行う必要がある。

token endpoint の `resource` は任意。省略時は認可コード・refresh 系列に束縛済みの resource を使用する。値がある場合は空文字も含めて検証し、束縛先と不一致なら拒否する。認可要求の `resource` は引き続き必須。

## 保存とログ

`MCP_PASSCODE` は Keychain に保管し、`keychain://MCP_PASSCODE` を `akc run` で解決してプロセスに注入する。16〜1024 byte の十分ランダムな値を使い、`.env`、引数、ソース、ログへ実値を書かない。起動時にランダム salt 付き scrypt ハッシュへ変換し、比較は `node:crypto` の `timingSafeEqual` で行う。

クライアント ID、同意要求、cookie、code、access / refresh token は SHA-256 ハッシュだけを保存する。クライアントの表示名・redirect URI・resource・未完了要求の state は保存されるため、ストアも私的な運用データとして扱う。`OAUTH_STORE_DIR` は専用の絶対ディレクトリを環境変数で指定できる。既定は macOS のユーザー Application Support、Linux の XDG data、Windows の LocalAppData 内である。ディレクトリは 0700、`store.json` は 0600。所有者・権限・schema・resource を検証し、破損したストアから新規セッションを作って復旧することはしない。

保存は同じディレクトリの一時ファイルへの書き込み、fsync、原子的 rename、ディレクトリ fsync の順で行う。ディレクトリ単位のプロセス内 mutex でトランザクションを直列化する。`transaction.lock` は PID とプロセス開始時刻を含む0600ファイルで、内容を完成させた一時ファイルの hard link で原子的に作成する。PID の死亡を確認した場合だけ同じ lock inode に回復 claim を原子的に追記し、最初の生存 claim が排他を獲得する。競合する回復プロセスが新しい lock を誤って除去することを防ぐ。生きている書き手には最大5秒待ってから失敗する。PID の再利用、権限不足、壊れた旧形式ロックなど死亡を証明できない場合は奪わない。通常は1プロセスで運用する。旧形式の空ロックが残った場合は、停止して他の書き手がいないことを確認してから除去する。

ストアの解析結果は mtime / size と ctime / inode をキーにメモリーキャッシュする。Bearer 検証では繰り返し JSON 解析や全データのコピーをせず、外部の取り消し・変更を次の読み取りで検知する。キャッシュ使用時もファイルの所有者・権限・symlink を検証する。トランザクションはコピーを変更し、失敗した変更がキャッシュに残らない。

refresh 再送用に保存するのは旧 token のハッシュ、交換時刻、新 refresh のハッシュとランダム salt だけ。提示された旧 token を鍵にした用途別 HMAC と salt で新ペアを再現するので、再起動しても10秒の猶予が保たれる。salt はトークンではなく、それだけで Bearer を生成できない。後続の rotation が完了した旧 token に猶予は適用しない。

アクセスログは固定ラベルの route / method と status だけ。IP、Host、クエリー、本文、Authorization、Cookie、client ID、パスコード、PSK はロガーに渡さない。リバースプロキシや別のログ機構も本文・ヘッダー・URL クエリーを記録しない設定にする。

## 脅威と運用

| 脅威 | 対策・限界 |
|---|---|
| 公開 URL の漏えい | URL は秘密の認証情報として扱わない。OAuth で MCP を守り、デバイス入口を非公開にする |
| パスコードの総当たり | 15分の窓内でクライアント単位と全体の失敗を数える。どちらかが5回に達すると最後の失敗から15分間、正しいパスコードでも拒否する。再起動や別の DCR 登録で全体ブロックを回避できない |
| トークン盗難 | HTTPS、短い access 寿命、resource 束縛、refresh rotation と再利用検知。Bearer なので、盗まれた現在の access token は期限切れ・取り消しまで使われ得る |
| 認可コード横取り / オープンリダイレクト | S256 PKCE、redirect の登録と完全一致、resource / client の照合、使い捨て code、ブラウザーに束縛した同意、state / issuer の往復 |
| DCR・同意要求による資源枯渇 | 登録100件、未完了同意256件、code256件、access / refresh 各4096件、OAuth 本文8 KiB、HTTP 本文64 KiBまで。期限切れは認可・トークン処理時に整理。DCR は origin 制限・未使用登録の整理を行う。全体ブロックはローカル unlock で復旧できるが、公開中の妨害は残るため不要時は Funnel を閉じる |
| 同じホストの別サービスへの影響 | 選択ポートだけを操作し、競合する設定は拒否する。他ポートを消す reset は使わない |
| ローカルユーザーの侵害 | Keychain と私的なストア権限で保護。同じ OS ユーザーで動く悪意あるプロセスやホスト侵害はこの最小認可サーバーの信頼境界外 |

取り消す場合はブリッジを停止して、ビルド済みのリポジトリで実行する。

```sh
npx --no-install dots-stackchan revoke
```

同じ `OAUTH_STORE_DIR` を指定する。登録クライアント、同意要求、code、access / refresh token を全て取り消す。ロックアウトの記録は残す。再接続には DCR と同意が必要で、パスコードだけを変更しても既存 token は取り消されない。取り消し後は新しい `MCP_PUBLIC_URL` にストアを束縛し直せる。緊急時はまず `bash scripts/funnel.sh down --port 8443` で公開を閉じる。

全体ロックアウトで所有者が入れない場合は、同じ `OAUTH_STORE_DIR` を指定してローカル端末で実行する。

```sh
npx --no-install dots-stackchan unlock
```

`unlock` は各ロックアウトの期限を0にし、失敗回数を保持する。正しいパスコードで再認可でき、既存クライアント・code・token は取り消されない。保持した回数が5以上なら次の失敗で再びブロックする。HTTP 経由の解除 API はない。継続攻撃時は先に Funnel を閉じる。

HTTP リスナーは `requestTimeout` / `headersTimeout` を各30秒、`keepAliveTimeout` を5秒に設定する。

Funnel の CLI と利用条件は [Tailscale Funnel](https://tailscale.com/docs/reference/tailscale-cli/funnel) を参照する。`--bg` の公開は再起動後にも継続する。`status` の出力はホスト名を伏せる。up / down の CLI 出力も抑止して、私的な DNS 名をログに残さない。

## 検証範囲

自動テストは不正 redirect、PKCE、resource、CSRF、重複パラメータ、code 再利用、期限切れ、refresh rotation / 再利用、ストア権限・破損、取り消し、全体ロックアウト、ログの秘匿を確認する。SDK の標準 OAuth による discovery → DCR → 同意 → token → 実 HTTP リスナーの MCP ツール呼び出しも通す。テストでは公開 HTTPS URL をループバックに写像し、Funnel の設定や実際の TLS 終端は変更しない。

Chromium によるブラウザー E2E は、公開 HTTPS テスト URL を `127.0.0.1` の HTTP リスナーに写像し、ブラウザーが生成する Origin / Secure cookie / CSP を維持して同意フォーム → code → token を検証する。

```sh
PLAYWRIGHT_BROWSERS_PATH=node_modules/.cache/playwright npx playwright install chromium
npm run test:browser
```

ブラウザー起動が許可されない環境では、ヘッダーの回帰テストに加え、手動で同意画面を開き、開発者ツールで200応答の `Referrer-Policy: same-origin`、POST の Origin が issuer と一致、303 callback の code / state / iss、token 交換200を確認する。画面・ログへ実値のパスコードや token を保存しない。

ChatGPT のアプリ登録、実際の Funnel の HTTPS 到達性、デバイスの PSK-HMAC・音声・サーボは統合後に利用者が確認する。認証なしの公開はサポートしない。証跡のホスト名、アカウント名、コード、token は公開前に伏せる。
