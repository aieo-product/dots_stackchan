# Contributing

Issue や Pull Request を歓迎します。作業前に [プライバシーポリシー](docs/privacy.md) を読み、
個人情報・秘密情報をコード、履歴、ログ、画像、動画に含めないでください。

## 開発手順

1. Node.js 22 以上で `npm install` を実行します。
2. 変更を加え、`npm run check` を実行します。
3. firmware の変更時は `cd firmware && pio run` も実行します。
4. Conventional Commits 形式でコミットします。

共有するログは `bash scripts/redact.sh < input.log` でマスクしてください。PR には確認方法と、
private project から移植したファイルおよび除去した個人情報を明記してください。
