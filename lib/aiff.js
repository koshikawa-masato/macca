// AIFF / AIFF-C メタデータパーサ
// COMM チャンク (再生時間) と、iTunes などが書き込む "ID3 " チャンクを読む。

import { readAt } from './util.js';
import { parseId3 } from './id3.js';

/** IEEE 754 80 ビット拡張浮動小数点 (COMM の sampleRate) */
function readExtended80(buf, off) {
  const exponent = buf.readUInt16BE(off) & 0x7fff;
  const hi = buf.readUInt32BE(off + 2);
  const lo = buf.readUInt32BE(off + 6);
  const mantissa = hi * 2 ** 32 + lo;
  if (exponent === 0 && mantissa === 0) return 0;
  return mantissa * 2 ** (exponent - 16383 - 63);
}

const MAX_ID3_CHUNK = 64 * 1024 * 1024;

export async function parseAiff(fh, fileSize) {
  const head = await readAt(fh, 0, 12);
  if (head.length < 12 || head.toString('ascii', 0, 4) !== 'FORM') return null;
  const formType = head.toString('ascii', 8, 12);
  if (formType !== 'AIFF' && formType !== 'AIFC') return null;

  let tags = {};
  let duration = null;
  let art = null;

  let pos = 12;
  for (let guard = 0; guard < 4096 && pos + 8 <= fileSize; guard++) {
    const ch = await readAt(fh, pos, 8);
    if (ch.length < 8) break;
    const id = ch.toString('ascii', 0, 4);
    const size = ch.readUInt32BE(4);
    const dataPos = pos + 8;

    if (id === 'COMM' && size >= 18) {
      const b = await readAt(fh, dataPos, 18);
      const numFrames = b.readUInt32BE(2);
      const sampleRate = readExtended80(b, 8);
      if (sampleRate > 0) duration = numFrames / sampleRate;
    } else if (id === 'ID3 ' && size > 10 && size <= MAX_ID3_CHUNK) {
      const b = await readAt(fh, dataPos, size);
      const parsed = parseId3(b, dataPos);
      if (parsed) {
        tags = { ...parsed.tags, ...tags };
        if (!art) art = parsed.art;
      }
    }

    pos = dataPos + size + (size % 2); // チャンクは偶数境界に揃う
  }

  return { tags, duration, codec: formType === 'AIFC' ? 'aifc' : 'aiff', art };
}
