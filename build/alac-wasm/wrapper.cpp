// Apple ALAC デコーダの WASM 用 C ラッパー
// public/player/alac.js から呼ばれる最小限のフラット API を公開する。

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "ALACDecoder.h"
#include "ALACBitUtilities.h"

extern "C" {

// クッキー (ALACSpecificConfig) からデコーダを生成する。失敗時は 0。
ALACDecoder* alac_create(uint8_t* cookie, uint32_t cookieSize) {
  ALACDecoder* dec = new ALACDecoder();
  if (dec->Init(cookie, cookieSize) != ALAC_noErr) {
    delete dec;
    return nullptr;
  }
  return dec;
}

uint32_t alac_frame_length(ALACDecoder* dec) { return dec->mConfig.frameLength; }
uint32_t alac_channels(ALACDecoder* dec) { return dec->mConfig.numChannels; }
uint32_t alac_bit_depth(ALACDecoder* dec) { return dec->mConfig.bitDepth; }
uint32_t alac_sample_rate(ALACDecoder* dec) { return dec->mConfig.sampleRate; }

// 1 パケットをデコードする。out には bitDepth に応じてパックされた
// インターリーブ PCM (16bit → 2 バイト、24bit → 3 バイト、32bit → 4 バイト) が
// 書き込まれる。返り値はデコードされたフレーム数 (負値はエラー)。
int32_t alac_decode(ALACDecoder* dec, uint8_t* packet, uint32_t packetSize,
                    uint8_t* out) {
  BitBuffer bits;
  BitBufferInit(&bits, packet, packetSize);
  uint32_t outFrames = 0;
  int32_t status = dec->Decode(&bits, out, dec->mConfig.frameLength,
                               dec->mConfig.numChannels, &outFrames);
  if (status != ALAC_noErr) return status < 0 ? status : -1;
  return (int32_t)outFrames;
}

void alac_destroy(ALACDecoder* dec) { delete dec; }

} // extern "C"
