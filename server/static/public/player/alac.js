// Apple ALAC デコーダ (WASM) の JS ラッパー (ブラウザ / Node 両対応)
// alac.wasm は build/alac-wasm/build.sh で Apple のリファレンス実装
// (Apache 2.0) からビルドしたもの。

/**
 * @param {BufferSource} wasmBytes alac.wasm の中身
 * @returns {Promise<{createDecoder(cookie: Uint8Array): AlacDecoder}>}
 */
export async function loadAlac(wasmBytes) {
  const { instance } = await WebAssembly.instantiate(wasmBytes, {
    env: { emscripten_notify_memory_growth: () => {} },
  });
  instance.exports._initialize?.();
  return {
    createDecoder(cookie) {
      return new AlacDecoder(instance, cookie);
    },
  };
}

class AlacDecoder {
  constructor(instance, cookie) {
    this.ex = instance.exports;
    const cookiePtr = this.ex.malloc(cookie.byteLength);
    new Uint8Array(this.ex.memory.buffer, cookiePtr, cookie.byteLength).set(cookie);
    this.handle = this.ex.alac_create(cookiePtr, cookie.byteLength);
    this.ex.free(cookiePtr);
    if (!this.handle) throw new Error('ALAC デコーダの初期化に失敗しました');

    this.frameLength = this.ex.alac_frame_length(this.handle);
    this.channels = this.ex.alac_channels(this.handle);
    this.bitDepth = this.ex.alac_bit_depth(this.handle);
    this.sampleRate = this.ex.alac_sample_rate(this.handle);

    this.bytesPerSample = Math.ceil(this.bitDepth / 8);
    this.outPtr = this.ex.malloc(this.frameLength * this.channels * 4);
    this.pktPtr = 0;
    this.pktCap = 0;
  }

  /**
   * 1 パケットをデコードして、チャンネルごとの Float32Array に書き足す。
   * @param {Uint8Array} packet
   * @param {Float32Array[]} channelData 出力先 (channels 本)
   * @param {number} writePos 書き込み開始フレーム位置
   * @returns {number} デコードされたフレーム数
   */
  decodeInto(packet, channelData, writePos) {
    if (packet.byteLength > this.pktCap) {
      if (this.pktPtr) this.ex.free(this.pktPtr);
      this.pktCap = Math.max(packet.byteLength, 64 * 1024);
      this.pktPtr = this.ex.malloc(this.pktCap);
    }
    new Uint8Array(this.ex.memory.buffer, this.pktPtr, packet.byteLength).set(packet);
    const frames = this.ex.alac_decode(this.handle, this.pktPtr, packet.byteLength, this.outPtr);
    if (frames < 0) throw new Error(`ALAC デコードエラー (${frames})`);

    // memory.buffer は malloc で growth する可能性があるため毎回ビューを張り直す
    const mem = this.ex.memory.buffer;
    const ch = this.channels;
    const limit = Math.min(frames, channelData[0].length - writePos);
    if (this.bitDepth === 16) {
      const out = new Int16Array(mem, this.outPtr, frames * ch);
      for (let c = 0; c < ch; c++) {
        const dst = channelData[c];
        for (let i = 0; i < limit; i++) dst[writePos + i] = out[i * ch + c] / 0x8000;
      }
    } else if (this.bitDepth === 24) {
      const out = new Uint8Array(mem, this.outPtr, frames * ch * 3);
      for (let c = 0; c < ch; c++) {
        const dst = channelData[c];
        for (let i = 0; i < limit; i++) {
          const p = (i * ch + c) * 3;
          const raw = out[p] | (out[p + 1] << 8) | (out[p + 2] << 16);
          dst[writePos + i] = ((raw << 8) >> 8) / 0x800000; // LE + 符号拡張
        }
      }
    } else if (this.bitDepth === 32) {
      const out = new Int32Array(mem, this.outPtr, frames * ch);
      for (let c = 0; c < ch; c++) {
        const dst = channelData[c];
        for (let i = 0; i < limit; i++) dst[writePos + i] = out[i * ch + c] / 0x80000000;
      }
    } else {
      throw new Error(`未対応の ALAC ビット深度: ${this.bitDepth}`);
    }
    return limit;
  }

  destroy() {
    if (this.handle) this.ex.alac_destroy(this.handle);
    if (this.outPtr) this.ex.free(this.outPtr);
    if (this.pktPtr) this.ex.free(this.pktPtr);
    this.handle = this.outPtr = this.pktPtr = 0;
  }
}

/**
 * demuxMp4() の結果から全パケットをデコードして PCM を返す。
 * @param {{cookie: Uint8Array, packets: {offset:number,size:number}[], totalSamples: number|null}} demuxed
 * @param {Uint8Array} fileBytes ファイル全体
 * @param {{createDecoder: Function}} alacModule loadAlac() の戻り値
 * @returns {{sampleRate: number, channels: number, length: number, channelData: Float32Array[]}}
 */
export function decodeAlacTrack(demuxed, fileBytes, alacModule) {
  const dec = alacModule.createDecoder(demuxed.cookie);
  try {
    const capacity = demuxed.totalSamples ?? demuxed.packets.length * dec.frameLength;
    const channelData = Array.from({ length: dec.channels }, () => new Float32Array(capacity));
    let pos = 0;
    for (const { offset, size } of demuxed.packets) {
      if (pos >= capacity) break;
      pos += dec.decodeInto(fileBytes.subarray(offset, offset + size), channelData, pos);
    }
    return {
      sampleRate: dec.sampleRate,
      channels: dec.channels,
      length: pos,
      channelData: pos === capacity ? channelData : channelData.map((c) => c.subarray(0, pos)),
    };
  } finally {
    dec.destroy();
  }
}
