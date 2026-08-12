#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
OUT="$ROOT/build/release"
TMP="${TMPDIR:-/tmp}/macca-release-$$"

cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

mkdir -p "$OUT" "$TMP"
cp -R "$ROOT"/. "$TMP"/
rm -rf "$TMP/.git" "$TMP/build/release" "$TMP/server/static/public"
mkdir -p "$TMP/server/static"
cp -R "$ROOT/public" "$TMP/server/static/public"

build_one() {
  goos=$1
  goarch=$2
  ext=$3
  name="macca-${goos}-${goarch}${ext}"
  echo "building $name"
  (cd "$TMP" && CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" go build -trimpath -ldflags "-s -w" -o "$OUT/$name" ./server)
}

build_one darwin arm64 ""
build_one darwin amd64 ""
build_one windows amd64 ".exe"
build_one linux amd64 ""
build_one linux arm64 ""

echo "release binaries written to $OUT"
