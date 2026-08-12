// AIFF / AIFC の純 JS デコーダ (ブラウザ / Node 両対応の ES モジュール)
// AIFF は実質ビッグエンディアン PCM なので、外部デコーダなしで正確に展開できる。
// 対応: 8/16/24/32bit 整数 (BE)、'sowt' (16bit LE)、'fl32'/'FL32'/'fl64' (float)

/** 80bit 拡張浮動小数点数 (SANE extended) を読む */
function readExt80(view, pos) {
  const exp = view.getUint16(pos) & 0x7fff;
  const hi = view.getUint32(pos + 2);
  const lo = view.getUint32(pos + 6);
  if (exp === 0 && hi === 0 && lo === 0) return 0;
  const mant = hi * 2 ** 32 + lo;
  return mant * 2 ** (exp - 16383 - 63);
}

/**
 * @param {Uint8Array} bytes ファイル全体
 * @returns {{sampleRate: number, channels: number, bitDepth: number,
 *            length: number, channelData: Float32Array[]}}
 */
export function decodeAiff(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 12 ||
      String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'FORM') {
    throw new Error('AIFF ではありません');
  }
  const formType = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  if (formType !== 'AIFF' && formType !== 'AIFC') {
    throw new Error(`未対応の FORM タイプ: ${formType}`);
  }

  let comm = null;
  let ssnd = null;
  let pos = 12;
  const end = bytes.byteLength;
  while (pos + 8 <= end) {
    const id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
    const size = view.getUint32(pos + 4);
    const dataStart = pos + 8;
    if (dataStart + size > end && id !== 'SSND') break;
    if (id === 'COMM' && size >= 18) {
      comm = {
        channels: view.getUint16(dataStart),
        numFrames: view.getUint32(dataStart + 2),
        bitDepth: view.getUint16(dataStart + 6),
        sampleRate: readExt80(view, dataStart + 8),
        compression: formType === 'AIFC' && size >= 22
          ? String.fromCharCode(bytes[dataStart + 18], bytes[dataStart + 19],
              bytes[dataStart + 20], bytes[dataStart + 21])
          : 'NONE',
      };
    } else if (id === 'SSND' && size >= 8) {
      const offset = view.getUint32(dataStart);
      ssnd = {
        start: dataStart + 8 + offset,
        end: Math.min(dataStart + size, end),
      };
    }
    pos = dataStart + size + (size % 2); // チャンクは偶数境界にパディング
  }

  if (!comm || !ssnd) throw new Error('COMM / SSND チャンクが見つかりません');
  const { channels, bitDepth, sampleRate } = comm;
  const comp = comm.compression;
  if (!['NONE', 'twos', 'sowt', 'fl32', 'FL32', 'fl64', 'in24', 'in32', 'raw '].includes(comp)) {
    throw new Error(`未対応の AIFC 圧縮形式: ${comp}`);
  }
  const littleEndian = comp === 'sowt';
  const isFloat32 = comp === 'fl32' || comp === 'FL32';
  const isFloat64 = comp === 'fl64';
  const bytesPer = isFloat64 ? 8 : Math.ceil(bitDepth / 8);

  const avail = Math.floor((ssnd.end - ssnd.start) / (bytesPer * channels));
  const frames = Math.min(comm.numFrames || avail, avail);
  const channelData = Array.from({ length: channels }, () => new Float32Array(frames));

  let p = ssnd.start;
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < channels; ch++) {
      let v;
      if (isFloat32) v = view.getFloat32(p);
      else if (isFloat64) v = view.getFloat64(p);
      else if (bytesPer === 1) v = view.getInt8(p) / 0x80;
      else if (bytesPer === 2) v = view.getInt16(p, littleEndian) / 0x8000;
      else if (bytesPer === 3) {
        const raw = littleEndian
          ? bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16)
          : (bytes[p] << 16) | (bytes[p + 1] << 8) | bytes[p + 2];
        v = ((raw << 8) >> 8) / 0x800000; // 符号拡張
      } else v = view.getInt32(p, littleEndian) / 0x80000000;
      channelData[ch][i] = v;
      p += bytesPer;
    }
  }
  return { sampleRate, channels, bitDepth, length: frames, channelData };
}
