#!/bin/sh
# Windows 配布用 MSI を macOS/Linux 上で生成する (msitools の wixl を使用)。
#
#   必要なもの: go, node, msitools (brew install msitools)
#   使い方:     ./build/msi/build.sh
#   生成物:     build/release/macca.msi
#
# 中身は自己完結型の macca.exe (フロント埋め込み・GUIサブシステム =
# コンソールを開かない)。スタートメニューの「macca」から起動すると
# ブラウザが開き、閉じると自動終了する。

set -eu
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
OUT="$ROOT/build/release"
TMP="${TMPDIR:-/tmp}/macca-msi-$$"
mkdir -p "$OUT" "$TMP"
trap 'rm -rf "$TMP"' EXIT INT TERM

echo "== 1/3 Windows 用 macca.exe をビルド (public/ 埋め込み・GUI サブシステム)"
cp -R "$ROOT"/. "$TMP/src"
rm -rf "$TMP/src/.git" "$TMP/src/build/release" "$TMP/src/server/static/public"
mkdir -p "$TMP/src/server/static"
cp -R "$ROOT/public" "$TMP/src/server/static/public"
(cd "$TMP/src" && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 \
  go build -trimpath -ldflags "-s -w -H windowsgui" -o "$TMP/macca.exe" ./server)

echo "== 2/3 ショートカット用アイコン (.ico) を生成"
node "$ROOT/build/msi/make-ico.mjs" \
  "$ROOT/macca.app/Contents/Resources/macca.icns" "$TMP/macca.ico"

echo "== 3/3 MSI を生成"
cp "$ROOT/build/msi/macca.wxs" "$TMP/"
(cd "$TMP" && wixl -v macca.wxs -o "$OUT/macca.msi" >/dev/null)
msiinfo suminfo "$OUT/macca.msi" | head -5
ls -la "$OUT/macca.msi"
