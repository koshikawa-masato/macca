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

build_one() {
  goos=$1
  goarch=$2
  ext=$3
  name="macca-${goos}-${goarch}${ext}"
  echo "building $name"
  (cd "$ROOT" && CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" go build -trimpath -ldflags "-s -w" -o "$OUT/$name" ./cmd/macca)
}

build_one darwin arm64 ""
build_one darwin amd64 ""
build_one windows amd64 ".exe"
build_one linux amd64 ""
build_one linux arm64 ""

echo "release binaries written to $OUT"
