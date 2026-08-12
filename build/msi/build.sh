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
VERSION=$(git describe --tags --always 2>/dev/null | sed "s/^v//")
LDFLAGS="-s -w -X github.com/koshikawa-masato/macca/server.Version=${VERSION:-dev}"
OUT="$ROOT/build/release"
TMP="${TMPDIR:-/tmp}/macca-msi-$$"
mkdir -p "$OUT" "$TMP"
trap 'rm -rf "$TMP"' EXIT INT TERM

echo "== 1/3 Windows 用 macca.exe をビルド (public/ 埋め込み・GUI サブシステム)"
(cd "$ROOT" && CGO_ENABLED=0 GOOS=windows GOARCH=amd64 \
  go build -trimpath -ldflags "$LDFLAGS -H windowsgui" -o "$TMP/macca.exe" ./cmd/macca)

echo "== 2/3 ショートカット用アイコン (.ico) を生成"
node "$ROOT/build/msi/make-ico.mjs" \
  "$ROOT/macca.app/Contents/Resources/macca.icns" "$TMP/macca.ico"

echo "== 3/3 MSI を生成"
cp "$ROOT/build/msi/macca.wxs" "$TMP/"
(cd "$TMP" && wixl -v macca.wxs -o "$OUT/macca.msi" >/dev/null)
msiinfo suminfo "$OUT/macca.msi" | head -5
ls -la "$OUT/macca.msi"
