// WAV (RIFF) メタデータパーサ
// fmt / data チャンクから再生時間、LIST INFO と "id3 " チャンクからタグを読む。

import { readAt, decodeLoose, parseYear } from './util.js';
import { parseId3 } from './id3.js';

const INFO_KEYS = {
  INAM: 'title',
  IART: 'artist',
  IPRD: 'album',
  IGNR: 'genre',
  ICRD: 'year',
};

const MAX_CHUNK = 64 * 1024 * 1024;

export async function parseWav(fh, fileSize) {
  const head = await readAt(fh, 0, 12);
  if (head.length < 12 || head.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (head.toString('ascii', 8, 12) !== 'WAVE') return null;

  let tags = {};
  let byteRate = 0;
  let dataSize = 0;
  let art = null;

  let pos = 12;
  for (let guard = 0; guard < 4096 && pos + 8 <= fileSize; guard++) {
    const ch = await readAt(fh, pos, 8);
    if (ch.length < 8) break;
    const id = ch.toString('ascii', 0, 4);
    const size = ch.readUInt32LE(4);
    const dataPos = pos + 8;

    if (id === 'fmt ' && size >= 16) {
      const b = await readAt(fh, dataPos, 16);
      byteRate = b.readUInt32LE(8);
    } else if (id === 'data') {
      dataSize = size;
    } else if (id === 'LIST' && size >= 4 && size <= MAX_CHUNK) {
      const b = await readAt(fh, dataPos, size);
      if (b.toString('ascii', 0, 4) === 'INFO') {
        let p = 4;
        while (p + 8 <= b.length) {
          const subId = b.toString('ascii', p, p + 4);
          const subSize = b.readUInt32LE(p + 4);
          if (subSize > b.length - p - 8) break;
          const field = INFO_KEYS[subId];
          if (field) {
            const raw = b.subarray(p + 8, p + 8 + subSize);
            const end = raw.indexOf(0);
            const value = decodeLoose(end === -1 ? raw : raw.subarray(0, end)).trim();
            if (value && tags[field] === undefined) tags[field] = value;
          }
          p += 8 + subSize + (subSize % 2);
        }
      }
    } else if ((id === 'id3 ' || id === 'ID3 ') && size > 10 && size <= MAX_CHUNK) {
      const b = await readAt(fh, dataPos, size);
      const parsed = parseId3(b, dataPos);
      if (parsed) {
        tags = { ...parsed.tags, ...tags };
        if (!art) art = parsed.art;
      }
    }

    pos = dataPos + size + (size % 2);
  }

  const duration = byteRate > 0 && dataSize > 0 ? dataSize / byteRate : null;
  if (tags.year !== undefined) tags.year = parseYear(tags.year);
  return { tags, duration, codec: 'pcm', art };
}
