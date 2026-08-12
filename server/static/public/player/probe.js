// デコード前にサンプルレートを調べる軽量プローブ (ブラウザ / Node 両対応)
// AudioContext を音源と同じレートで作ることで、不要なリサンプリングを避ける。

const MP3_RATES = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000],  // MPEG2.5
};

function probeMp3(bytes, view) {
  let pos = 0;
  // 先頭の ID3v2 をスキップ
  if (bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    pos = 10 + (((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) |
      ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f));
  }
  const limit = Math.min(bytes.length - 4, pos + 256 * 1024);
  for (; pos < limit; pos++) {
    if (bytes[pos] !== 0xff || (bytes[pos + 1] & 0xe0) !== 0xe0) continue;
    const version = (bytes[pos + 1] >> 3) & 3;   // 0=2.5, 2=2, 3=1
    const layer = (bytes[pos + 1] >> 1) & 3;
    const rateIdx = (bytes[pos + 2] >> 2) & 3;
    if (version === 1 || layer === 0 || rateIdx === 3) continue;
    const rates = MP3_RATES[version];
    if (!rates) continue;
    const channels = ((bytes[pos + 3] >> 6) & 3) === 3 ? 1 : 2;
    return { sampleRate: rates[rateIdx], channels };
  }
  return null;
}

function probeFlac(bytes, view) {
  if (bytes.length < 22 ||
      String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'fLaC') return null;
  // 最初のメタデータブロックは必ず STREAMINFO
  const sampleRate = (bytes[18] << 12) | (bytes[19] << 4) | (bytes[20] >> 4);
  const channels = ((bytes[20] >> 1) & 0x07) + 1;
  return sampleRate > 0 ? { sampleRate, channels } : null;
}

function probeWav(bytes, view) {
  if (bytes.length < 12 ||
      String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'RIFF') return null;
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
    const size = view.getUint32(pos + 4, true);
    if (id === 'fmt ' && size >= 16) {
      return {
        sampleRate: view.getUint32(pos + 12, true),
        channels: view.getUint16(pos + 10, true),
      };
    }
    pos += 8 + size + (size % 2);
  }
  return null;
}

function probeAiff(bytes, view) {
  if (bytes.length < 12 ||
      String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'FORM') return null;
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
    const size = view.getUint32(pos + 4);
    if (id === 'COMM' && size >= 18) {
      const exp = view.getUint16(pos + 16) & 0x7fff;
      const mant = view.getUint32(pos + 18) * 2 ** 32 + view.getUint32(pos + 22);
      const rate = exp === 0 && mant === 0 ? 0 : mant * 2 ** (exp - 16383 - 63);
      return { sampleRate: rate, channels: view.getUint16(pos + 8) };
    }
    pos += 8 + size + (size % 2);
  }
  return null;
}

/**
 * ファイル先頭部からサンプルレートとチャンネル数を推定する。
 * m4a は demux-mp4.js の demuxMp4() を使うこと (moov が末尾にある場合があるため)。
 * @param {Uint8Array} bytes
 * @param {string} ext 拡張子 ('.mp3' など)
 * @returns {{sampleRate: number, channels: number} | null}
 */
export function probeSampleRate(bytes, ext) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (ext) {
    case '.mp3': case '.aac': return probeMp3(bytes, view);
    case '.flac': return probeFlac(bytes, view);
    case '.wav': return probeWav(bytes, view);
    case '.aif': case '.aiff': case '.aifc': return probeAiff(bytes, view);
    default: return null;
  }
}
