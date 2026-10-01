# Dots custom MCP app 接続スパイク

OpenAI Dots から認証なしの custom MCP app を利用できるか確認するための、一時的な echo サーバーです。Node.js 20 以上と Tailscale が必要です。

## 1. インストールと起動

```sh
cd spikes/mcp-echo
npm install
npm start
```

既定では `127.0.0.1:8790` の `/mcp` で待ち受けます。`PORT` と `BASE_PATH` で変更できます。たとえば `BASE_PATH=/local-test` の場合は `/local-test/mcp` と `/mcp` の両方を受け付けます。

## 2. MCP Inspector で確認

別のターミナルで Inspector を起動します。

```sh
npx @modelcontextprotocol/inspector
```

Streamable HTTP を選び、URL に `http://127.0.0.1:8790/mcp` を指定します。`echo` と `ring` が一覧に出て、`echo` が入力をそのまま返し、`ring` が `rang` を返すことを確認します。

## 3. Funnel を公開

```sh
./funnel.sh up
```

スクリプトは推測困難な24文字のパスを生成し、公開用のマスク済み URL を表示します。実ホスト名を含む URL は、手元で `tailscale funnel status` を実行して確認してください。

`tailscale funnel --set-path` は公開側のマウントパスをバックエンドへ渡す前に取り除きます。そのため、公開 URL が `/spike-<random>/mcp` でも、このサーバーは転送後の `/mcp` を受け付けます。`BASE_PATH` 付きのローカルアクセスも利用できます。

## 4. ChatGPT と Dot で確認

1. ChatGPT の開発者モードを有効にし、custom app を追加します。
2. MCP URL に Funnel の実 URL（末尾 `/mcp`）を指定し、認証は「なし」を選びます。
3. 通常チャットから `echo` を呼び、入力がそのまま返ることを確認します。
4. 通常チャットから `ring` を呼び、承認ダイアログの有無と内容を記録します。
5. custom app を Dot に追加し、Dot から `echo` と `ring` を呼びます。
6. Events の購読 UI が表示されるか、`spike.ping` を選べるか確認します。購読・解除は記録だけを行い、イベント配信はしません。
7. Slack を接続した構成でも、MCP app と併用できるか確認します。
8. 結果を `docs/research/dots-integration.md` の未記入欄へ追記します。

サーバーログにはメソッド名、ツール名、時刻、ステータスだけを記録します。公開 URL や実ホスト名をログ・issue・スクリーンショットへ残さないでください。詳細は [プライバシーポリシー](../../docs/privacy.md) を参照してください。

## 5. Funnel を停止

```sh
./funnel.sh down
```

保存したランダムパスだけを停止します。ほかの Funnel 設定には触れません。状態の確認は次で行えます（出力中の `.ts.net` ホスト名はマスクされます）。

```sh
./funnel.sh status
```
