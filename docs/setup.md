# MCP App の接続準備

MCP App は Dot とスタックちゃんをつなぐ既定の経路である。ChatGPT の接続アプリでスタックちゃんをオンにしている間だけ Dot がスタックちゃんに働きかける。オフにすれば、Dot からスタックちゃんをすぐ切り離せる。セキュリティ上の取り消しには OAuth の revoke も行う。

この段階では実デバイス依存とブリッジの起動処理への配線が必要である。統合側は次の順に専用の MCP リスナーを作る。

```ts
import { createMcpServer } from "./mcp/server.js";
import { readOAuthConfig } from "./oauth/config.js";
import { createOAuth } from "./oauth/index.js";

const oauth = createOAuth(readOAuthConfig());
const server = createMcpServer(dependencies, { oauth });
await server.listen(mcpPort); // loopback; dedicated to MCP/OAuth
```

別の fetch ベース HTTP アダプターなら `wrapMcpHandler(oauth, mcpHandler)` を使う。ラッパー全体をルートに配線して discovery と OAuth も処理させ、他の URL をデバイスハンドラーへフォールバックしない。終了時は `server.close()` を呼ぶ。

1. Node.js 22 以上で `npm install`。prepare が CLI 用 JavaScript をビルドする。更新後は `npm run build` も実行する。
2. Keychain に `akc set MCP_PASSCODE` でパスコードを登録する。既存デバイスの PSK は別のキーとして維持する。
3. 実際の DNS 名はローカルで確認し、環境変数だけで設定する。公開 URL は次の形式で、既定ポートの `:8443` を含める。
4. ブリッジ統合の起動コマンドを `akc run -- <bridge-command>` で実行する。
5. 専用リスナーが起動したら `bash scripts/funnel.sh up`。443 が空いていれば `--port 443` に変更し、URL のポート表記も合わせる。
6. ChatGPT に MCP URL を登録し、OAuth を選択する。同意画面の返り先・権限を確認してパスコードを入力する。DCR は公開クライアント (`token_endpoint_auth_method=none`) に対応する。
7. `get_status`、短い `say`、表情、首の小さい角度の順に実機確認する。停止は `bash scripts/funnel.sh down`、公開状況の確認は `bash scripts/funnel.sh status`。

```sh
export MCP_PUBLIC_URL='https://<your-host>.<your-tailnet>.ts.net:8443/mcp'
export MCP_PASSCODE=keychain://MCP_PASSCODE
export MCP_PORT=8791
# Optional: OAUTH_STORE_DIR must be an absolute, private directory outside the repository.
```

`FUNNEL_PORT` でも HTTPS ポートを指定できる。up / down には同じ MCP_PORT と選択ポートを使う。スクリプトは `tailscale status --json` から実行時の DNS 名を取得し、URL の一致を検証する。既存設定とぶつかる場合は変更せずに終了する。デバイスの `/device` は公開しない。

未認証応答の確認例:

```sh
curl --include "$MCP_PUBLIC_URL"
```

期待されるヘッダー（公開証跡用に伏せ字）:

```text
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://<your-host>.<your-tailnet>.ts.net:8443/.well-known/oauth-protected-resource/mcp", scope="stackchan"
```

ロックアウトや失効の運用は [security.md](security.md)、ツールの入力は [mcp.md](mcp.md) を参照する。ChatGPT の画面証跡を共有するときは、アカウント名・ホスト名・認可コード・token を伏せる。
