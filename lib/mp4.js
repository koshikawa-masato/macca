// MP4/M4A コンテナのメタデータパーサ (ALAC / AAC)
// moov アトムを丸ごと読み込み、mvhd (再生時間), stsd (コーデック),
// udta > meta > ilst (iTunes 形式タグ) を辿る。

import { readAt, parseTrackNumber, parseYear } from './util.js';
import { GENRES } from './id3.js';

const MAX_MOOV = 64 * 1024 * 1024; // 巨大な moov は読まない安全弁

/** buf 内 [start, end) のアトムを列挙する */
function* atoms(buf, start, end) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    let hdr = 8;
    if (size === 1) {
      if (pos + 16 > end) return;
      size = Number(buf.readBigUInt64BE(pos + 8));
      hdr = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < hdr || pos + size > end) return;
    yield { type, pos, size, hdr, dataStart: pos + hdr, dataEnd: pos + size };
    pos += size;
  }
}

function findAtom(buf, start, end, type) {
  for (const a of atoms(buf, start, end)) if (a.type === type) return a;
  return null;
}

/** ネストしたパスを辿る。'meta' アトムは 4 バイトの version/flags を挟む */
function findPath(buf, start, end, path) {
  let s = start, e = end;
  for (const type of path) {
    const a = findAtom(buf, s, e, type);
    if (!a) return null;
    s = a.dataStart + (type === 'meta' ? 4 : 0);
    e = a.dataEnd;
  }
  return { dataStart: s, dataEnd: e };
}

const ILST_KEYS = {
  '©nam': 'title',
  '©ART': 'artist',
  'aART': 'albumArtist',
  '©alb': 'album',
  '©gen': 'genre',
  '©day': 'year',
};

/**
 * @param {import('node:fs/promises').FileHandle} fh
 * @param {number} fileSize
 */
export async function parseMp4(fh, fileSize) {
  // トップレベルを seek しながら歩いて moov を探す
  let pos = 0;
  let moov = null;
  while (pos + 8 <= fileSize) {
    const head = await readAt(fh, pos, 16);
    if (head.length < 8) break;
    let size = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    let hdr = 8;
    if (size === 1 && head.length >= 16) {
      size = Number(head.readBigUInt64BE(8));
      hdr = 16;
    } else if (size === 0) {
      size = fileSize - pos;
    }
    if (size < hdr) break;
    if (type === 'moov') {
      moov = { pos, size, hdr };
      break;
    }
    pos += size;
  }
  if (!moov || moov.size > MAX_MOOV) return null;

  const buf = await readAt(fh, moov.pos, moov.size);
  const start = moov.hdr;
  const end = buf.length;

  const tags = {};
  let duration = null;
  let codec = null;
  let art = null;

  // mvhd: 再生時間
  const mvhd = findAtom(buf, start, end, 'mvhd');
  if (mvhd) {
    const d = mvhd.dataStart;
    const version = buf[d];
    if (version === 1 && mvhd.dataEnd - d >= 32) {
      const timescale = buf.readUInt32BE(d + 20);
      const dur = Number(buf.readBigUInt64BE(d + 24));
      if (timescale > 0) duration = dur / timescale;
    } else if (mvhd.dataEnd - d >= 20) {
      const timescale = buf.readUInt32BE(d + 12);
      const dur = buf.readUInt32BE(d + 16);
      if (timescale > 0) duration = dur / timescale;
    }
  }

  // stsd: コーデック判別 (alac / mp4a / flac ...)
  const stsd = findPath(buf, start, end, ['trak', 'mdia', 'minf', 'stbl', 'stsd']);
  if (stsd && stsd.dataEnd - stsd.dataStart >= 16) {
    const fmt = buf.toString('latin1', stsd.dataStart + 12, stsd.dataStart + 16);
    if (fmt === 'alac') codec = 'alac';
    else if (fmt === 'mp4a') codec = 'aac';
    else if (fmt === 'flac') codec = 'flac';
    else codec = fmt.trim();
  }

  // ilst: iTunes 形式メタデータ
  const ilst = findPath(buf, start, end, ['udta', 'meta', 'ilst']);
  if (ilst) {
    for (const item of atoms(buf, ilst.dataStart, ilst.dataEnd)) {
      const data = findAtom(buf, item.dataStart, item.dataEnd, 'data');
      if (!data || data.dataEnd - data.dataStart < 8) continue;
      const dataType = buf.readUInt32BE(data.dataStart) & 0x00ffffff;
      const payloadStart = data.dataStart + 8; // type(4) + locale(4)
      const payload = buf.subarray(payloadStart, data.dataEnd);

      const field = ILST_KEYS[item.type];
      if (field !== undefined && dataType === 1) {
        const value = payload.toString('utf8').trim();
        if (value && tags[field] === undefined) tags[field] = value;
      } else if (item.type === 'trkn' && payload.length >= 4) {
        tags.track = payload.readUInt16BE(2);
      } else if (item.type === 'disk' && payload.length >= 4) {
        tags.disc = payload.readUInt16BE(2);
      } else if (item.type === 'gnre' && payload.length >= 2 && tags.genre === undefined) {
        // ID3v1 ジャンル番号 + 1 で格納されている
        const g = GENRES[payload.readUInt16BE(0) - 1];
        if (g) tags.genre = g;
      } else if (item.type === 'covr' && payload.length > 0 && !art) {
        let mime = 'image/jpeg';
        if (dataType === 14 || (payload[0] === 0x89 && payload[1] === 0x50)) mime = 'image/png';
        art = { mime, offset: moov.pos + payloadStart, length: payload.length };
      }
    }
  }

  if (tags.track !== undefined) tags.track = parseTrackNumber(tags.track);
  if (tags.disc !== undefined) tags.disc = parseTrackNumber(tags.disc);
  if (tags.year !== undefined) tags.year = parseYear(tags.year);
  return { tags, duration, codec, art };
}
