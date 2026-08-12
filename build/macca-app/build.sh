#!/bin/sh
# macca.app のランチャーバイナリ (ユニバーサル) をビルドして
# macca.app/Contents/MacOS/macca-launcher を更新し、ad-hoc 署名する。
# 生成物はコミット済みなので通常は再実行不要 (launcher.swift を変えたときだけ)。

set -eu
cd "$(dirname "$0")"
ROOT="$(cd ../.. && pwd)"
TMP="${TMPDIR:-/tmp}/macca-app-build-$$"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT INT TERM

xcrun swiftc -O -target arm64-apple-macos12  -o "$TMP/launcher-arm64" launcher.swift
xcrun swiftc -O -target x86_64-apple-macos12 -o "$TMP/launcher-x86_64" launcher.swift
lipo -create -output "$ROOT/macca.app/Contents/MacOS/macca-launcher" \
  "$TMP/launcher-arm64" "$TMP/launcher-x86_64"

codesign --force --deep -s - "$ROOT/macca.app"
ls -la "$ROOT/macca.app/Contents/MacOS/macca-launcher"
