#!/bin/sh
# Apple ALAC デコーダ (https://github.com/macosforge/alac, Apache 2.0) を
# WASM にビルドして public/player/alac.wasm を生成する。
#
#   必要なもの: emscripten (brew install emscripten), git
#   使い方:     ./build/alac-wasm/build.sh
#
# 生成物はリポジトリにコミット済みなので、通常このスクリプトを
# 実行する必要はない (デコーダを更新するときだけ)。

set -eu
cd "$(dirname "$0")"

if [ ! -d alac-src ]; then
  git clone --depth 1 https://github.com/macosforge/alac.git alac-src
fi

em++ -Os --no-entry \
  -sSTANDALONE_WASM=1 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sEXPORTED_FUNCTIONS=_alac_create,_alac_decode,_alac_destroy,_alac_frame_length,_alac_channels,_alac_bit_depth,_alac_sample_rate,_malloc,_free \
  -fno-exceptions -fno-rtti \
  -std=gnu++14 -Wno-deprecated -Wno-register \
  -DTARGET_RT_LITTLE_ENDIAN=1 \
  -I alac-src/codec \
  wrapper.cpp \
  alac-src/codec/ALACDecoder.cpp \
  alac-src/codec/ag_dec.c \
  alac-src/codec/dp_dec.c \
  alac-src/codec/matrix_dec.c \
  alac-src/codec/ALACBitUtilities.c \
  alac-src/codec/EndianPortable.c \
  -o ../../public/player/alac.wasm

ls -la ../../public/player/alac.wasm
