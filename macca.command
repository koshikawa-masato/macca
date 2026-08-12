#!/bin/sh
# macca ワンクリック起動 (macOS)
# ダブルクリックするとサーバが起動し、ブラウザが自動で開きます。
# このウィンドウを閉じる (Ctrl+C) と macca は終了します。

cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js が見つかりません。https://nodejs.org からインストールしてください。"
  echo "(Enter キーで閉じます)"
  read -r _
  exit 1
fi

exec node server.js --open "$@"
