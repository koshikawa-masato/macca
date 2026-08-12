// FLAC メタデータパーサ
// STREAMINFO (再生時間) / VORBIS_COMMENT (タグ) / PICTURE (アートワーク)

import { readAt, parseTrackNumber, parseYear } from './util.js';

const VORBIS_KEYS = {
  TITLE: 'title',
  ARTIST: 'artist',
  ALBUMARTIST: 'albumArtist',
  ALBUM: 'album',
  GENRE: 'genre',
  DATE: 'year',
  TRACKNUMBER: 'track',
};

const MAX_BLOCK = 32 * 1024 * 1024;

export async function parseFlac(fh, fileSize) {
  const magic = await readAt(fh, 0, 4);
  if (magic.toString('ascii') !== 'fLaC') return null;

  const tags = {};
  let duration = null;
  let art = null;

  let pos = 4;
  for (let guard = 0; guard < 128; guard++) {
    const head = await readAt(fh, pos, 4);
    if (head.length < 4) break;
    const isLast = (head[0] & 0x80) !== 0;
    const type = head[0] & 0x7f;
    const size = (head[1] << 16) | (head[2] << 8) | head[3];
    const dataPos = pos + 4;
    if (dataPos + size > fileSize || size > MAX_BLOCK) break;

    if (type === 0 && size >= 18) { // STREAMINFO
      const b = await readAt(fh, dataPos, 18);
      const sampleRate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
      const totalSamples = (b[13] & 0x0f) * 2 ** 32 + b.readUInt32BE(14);
      if (sampleRate > 0 && totalSamples > 0) duration = totalSamples / sampleRate;
    } else if (type === 4) { // VORBIS_COMMENT
      const b = await readAt(fh, dataPos, size);
      let p = 0;
      if (p + 4 <= b.length) {
        const vendorLen = b.readUInt32LE(p); p += 4 + vendorLen;
        if (p + 4 <= b.length) {
          const count = b.readUInt32LE(p); p += 4;
          for (let i = 0; i < count && p + 4 <= b.length; i++) {
            const len = b.readUInt32LE(p); p += 4;
            if (p + len > b.length) break;
            const entry = b.toString('utf8', p, p + len); p += len;
            const eq = entry.indexOf('=');
            if (eq > 0) {
              const key = entry.slice(0, eq).toUpperCase();
              const field = VORBIS_KEYS[key];
              const value = entry.slice(eq + 1).trim();
              if (field && value && tags[field] === undefined) tags[field] = value;
            }
          }
        }
      }
    } else if (type === 6 && !art) { // PICTURE
      // ヘッダ部分 (mime + description) だけ読んで画像データの位置を計算する
      const headLen = Math.min(size, 64 * 1024);
      const b = await readAt(fh, dataPos, headLen);
      if (b.length >= 8) {
        let p = 4; // picture type
        const mimeLen = b.readUInt32BE(p); p += 4;
        if (p + mimeLen + 4 <= b.length) {
          const mime = b.toString('ascii', p, p + mimeLen) || 'image/jpeg';
          p += mimeLen;
          const descLen = b.readUInt32BE(p); p += 4 + descLen;
          p += 16; // width, height, depth, colors
          if (p + 4 <= b.length) {
            const dataLen = b.readUInt32BE(p); p += 4;
            if (dataPos + p + dataLen <= fileSize) {
              art = { mime, offset: dataPos + p, length: dataLen };
            }
          }
        }
      }
    }

    pos = dataPos + size;
    if (isLast) break;
  }

  if (tags.track !== undefined) tags.track = parseTrackNumber(tags.track);
  if (tags.year !== undefined) tags.year = parseYear(tags.year);
  return { tags, duration, codec: 'flac', art };
}
