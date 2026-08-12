#!/bin/sh
# macOS 配布用 DMG を作る:
#   ダウンロード → ダブルクリック → macca を Applications へドラッグ、の定番インストール画面。
# 中身は自己完結型の macca.app (フロント埋め込み済みのユニバーサル Go サーバを同梱)。
#
#   使い方: ./build/dmg/build.sh
#   生成物: build/release/macca.dmg

set -eu
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
VERSION=$(git describe --tags --always 2>/dev/null | sed "s/^v//")
LDFLAGS="-s -w -X github.com/koshikawa-masato/macca/server.Version=${VERSION:-dev}"
OUT="$ROOT/build/release"
TMP="${TMPDIR:-/tmp}/macca-dmg-$$"
mkdir -p "$OUT" "$TMP"
trap 'rm -rf "$TMP"; hdiutil detach "/Volumes/macca" >/dev/null 2>&1 || true' EXIT INT TERM

echo "== 1/4 ユニバーサル Go サーバをビルド (public/ 埋め込み)"
(cd "$ROOT" && CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags "$LDFLAGS" -o "$TMP/server-arm64" ./cmd/macca)
(cd "$ROOT" && CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -trimpath -ldflags "$LDFLAGS" -o "$TMP/server-amd64" ./cmd/macca)
lipo -create -output "$TMP/macca-server" "$TMP/server-arm64" "$TMP/server-amd64"

echo "== 2/4 自己完結型 macca.app を組み立て"
cp -R "$ROOT/macca.app" "$TMP/macca.app"
cp "$TMP/macca-server" "$TMP/macca.app/Contents/Resources/macca-server"
chmod +x "$TMP/macca.app/Contents/Resources/macca-server"
codesign --force --deep -s - "$TMP/macca.app"

echo "== 3/4 DMG ステージング (Applications リンクとレイアウト)"
STAGE="$TMP/stage"
mkdir -p "$STAGE"
cp -R "$TMP/macca.app" "$STAGE/macca.app"
ln -s /Applications "$STAGE/Applications"

hdiutil create -volname "macca" -srcfolder "$STAGE" -fs HFS+ -format UDRW -ov "$TMP/rw.dmg" >/dev/null
hdiutil attach "$TMP/rw.dmg" >/dev/null

# Finder ウィンドウのレイアウト (アイコンサイズ・位置) を設定
osascript <<EOF >/dev/null
tell application "Finder"
  tell disk "macca"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set bounds of container window to {200, 120, 760, 480}
    set opts to icon view options of container window
    set icon size of opts to 112
    set text size of opts to 13
    set arrangement of opts to not arranged
    set position of item "macca.app" of container window to {140, 170}
    set position of item "Applications" of container window to {420, 170}
    close
  end tell
end tell
EOF
sync
hdiutil detach "/Volumes/macca" >/dev/null

echo "== 4/4 圧縮 DMG に変換"
rm -f "$OUT/macca.dmg"
hdiutil convert "$TMP/rw.dmg" -format UDZO -imagekey zlib-level=9 -o "$OUT/macca.dmg" >/dev/null
ls -la "$OUT/macca.dmg"
