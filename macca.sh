#!/bin/sh
# macca ワンクリック起動 (Linux)
# ファイルマネージャから「実行」するか、ターミナルで ./macca.sh を実行すると
# サーバが起動し、ブラウザが自動で開きます。Ctrl+C で終了します。

cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js が見つかりません。https://nodejs.org またはディストリビューションの"
  echo "パッケージマネージャ (apt install nodejs 等) からインストールしてください。"
  read -r _
  exit 1
fi

exec node server.js --open --exit-on-close "$@"
