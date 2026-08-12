// FLAC フレーム索引 (ブラウザ / Node 両対応の純 JS)
//
// FLAC のフレームは自己完結 (ヘッダに位置・サイズ・CRC を持つ) なので、
// 境界の索引を作れば「必要な区間だけをミニ FLAC ファイルに切り出して
// ネイティブデコーダに渡す」ことができる。ストリーミング再生の土台。

const BLOCK_SIZES = [0, 192, 576, 1152, 2304, 4608, 0, 0, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768];

// CRC-8 (多項式 0x07) — フレームヘッダの検証用
const CRC8_TABLE = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let b = 0; b < 8; b++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
    t[i] = c;
  }
  return t;
})();

function crc8(bytes, start, end) {
  let c = 0;
  for (let i = start; i < end; i++) c = CRC8_TABLE[c ^ bytes[i]];
  return c;
}

/** FLAC 拡張 UTF-8 形式のフレーム/サンプル番号を読む。[値, 次位置] か null */
function readCodedNumber(bytes, pos) {
  const b0 = bytes[pos];
  if (b0 === undefined) return null;
  if (b0 < 0x80) return [b0, pos + 1];
  let len = 0;
  for (let mask = 0x40; b0 & mask; mask >>= 1) len++;
  if (len < 1 || len > 6) return null;
  let value = b0 & (0x3f >> len);
  for (let i = 1; i <= len; i++) {
    const b = bytes[pos + i];
    if (b === undefined || (b & 0xc0) !== 0x80) return null;
    value = value * 64 + (b & 0x3f);
  }
  return [value, pos + len + 1];
}

/**
 * FLAC ファイルのメタデータとフレーム索引を作る。
 * @param {Uint8Array} bytes ファイル全体
 * @returns {null | {
 *   sampleRate, channels, bitsPerSample, totalSamples,
 *   streamInfo: Uint8Array,   // STREAMINFO ブロック本体 (34 バイト)
 *   audioStart: number,       // 最初のフレームのオフセット
 *   frames: {offset: number, startSample: number, blockSize: number}[],
 * }}
 */
export function indexFlacFrames(bytes) {
  if (bytes.length < 42 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'fLaC') {
    return null;
  }
  // メタデータブロックを歩く
  let pos = 4;
  let streamInfo = null;
  for (;;) {
    if (pos + 4 > bytes.length) return null;
    const last = (bytes[pos] & 0x80) !== 0;
    const type = bytes[pos] & 0x7f;
    const size = (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
    if (type === 0 && size >= 34) streamInfo = bytes.subarray(pos + 4, pos + 4 + 34);
    pos += 4 + size;
    if (last) break;
  }
  if (!streamInfo || pos >= bytes.length) return null;

  const sampleRate = (streamInfo[10] << 12) | (streamInfo[11] << 4) | (streamInfo[12] >> 4);
  const nominalBlockSize = (streamInfo[2] << 8) | streamInfo[3]; // 最大ブロックサイズ (固定ストリームの公称値)
  const channels = ((streamInfo[12] >> 1) & 0x07) + 1;
  const bitsPerSample = (((streamInfo[12] & 1) << 4) | (streamInfo[13] >> 4)) + 1;
  const totalSamples = (streamInfo[13] & 0x0f) * 2 ** 32 +
    (streamInfo[14] * 2 ** 24 + (streamInfo[15] << 16) + (streamInfo[16] << 8) + streamInfo[17]);
  const audioStart = pos;

  // フレーム走査: sync (0b11111111111110xx) + ヘッダ CRC-8 + サンプル位置の連鎖で検証
  const frames = [];
  let expected = 0; // 次フレームの開始サンプル (連鎖検証で誤同期を排除する)
  let i = audioStart;
  while (i + 5 < bytes.length) {
    if (bytes[i] !== 0xff || (bytes[i + 1] & 0xfc) !== 0xf8) { i++; continue; }
    const variable = (bytes[i + 1] & 0x01) !== 0;
    const bsCode = bytes[i + 2] >> 4;
    const srCode = bytes[i + 2] & 0x0f;
    const chCode = bytes[i + 3] >> 4;
    if (bsCode === 0 || srCode === 15 || chCode > 10 || (bytes[i + 3] & 1) !== 0) { i++; continue; }

    const coded = readCodedNumber(bytes, i + 4);
    if (!coded) { i++; continue; }
    let [num, p] = coded;

    let blockSize = BLOCK_SIZES[bsCode];
    if (bsCode === 6) { blockSize = bytes[p] + 1; p += 1; }
    else if (bsCode === 7) { blockSize = ((bytes[p] << 8) | bytes[p + 1]) + 1; p += 2; }
    if (srCode === 12) p += 1;
    else if (srCode === 13 || srCode === 14) p += 2;
    if (p >= bytes.length || blockSize <= 0) { i++; continue; }
    if (crc8(bytes, i, p) !== bytes[p]) { i++; continue; }

    // 固定ブロックサイズのストリームではヘッダの num はフレーム番号。
    // 開始サンプルは公称ブロックサイズで計算する (最終フレームだけ実サイズが短い)
    const startSample = variable ? num : num * (nominalBlockSize || blockSize);
    if (startSample !== expected) { i++; continue; } // 連鎖しない候補は誤同期

    frames.push({ offset: i, startSample, blockSize });
    expected = startSample + blockSize;
    i = p + 1 + 4; // ヘッダの先へ (フレーム本体は次の sync 探索で飛ばす)
    if (totalSamples > 0 && expected >= totalSamples) break;
  }
  if (frames.length === 0) return null;
  return { sampleRate, channels, bitsPerSample, totalSamples, streamInfo, audioStart, frames };
}

/**
 * フレーム範囲 [fromIdx, toIdx] を単独でデコード可能なミニ FLAC ファイルにする。
 * @returns {Uint8Array}
 */
export function buildFlacSlice(bytes, index, fromIdx, toIdx) {
  const start = index.frames[fromIdx].offset;
  const end = toIdx + 1 < index.frames.length ? index.frames[toIdx + 1].offset : bytes.length;

  const header = new Uint8Array(4 + 4 + 34);
  header[0] = 0x66; header[1] = 0x4c; header[2] = 0x61; header[3] = 0x43; // fLaC
  header[4] = 0x80; // STREAMINFO / 最終メタデータブロック
  header[5] = 0; header[6] = 0; header[7] = 34;
  header.set(index.streamInfo, 8);
  // 総サンプル数は「不明」にする (スライスの実フレーム数と食い違うため)
  header[8 + 13] &= 0xf0;
  header[8 + 14] = 0; header[8 + 15] = 0; header[8 + 16] = 0; header[8 + 17] = 0;

  const out = new Uint8Array(header.length + (end - start));
  out.set(header, 0);
  out.set(bytes.subarray(start, end), header.length);
  return out;
}
