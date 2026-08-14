// ID3v2 タグパーサ (v2.2 / v2.3 / v2.4)
// mp3 先頭のタグのほか、AIFF の "ID3 " チャンク・WAV の "id3 " チャンクにも同じ構造が入る。

import { decodeId3Text, parseTrackNumber, parseYear } from './util.js';

// ID3v1 標準ジャンル (TCON が "(17)" のような番号参照のときに使う)
export const GENRES = [
  'Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop',
  'Jazz', 'Metal', 'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap',
  'Reggae', 'Rock', 'Techno', 'Industrial', 'Alternative', 'Ska', 'Death Metal', 'Pranks',
  'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion', 'Trance',
  'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise',
  'Alternative Rock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock',
  'Ethnic', 'Gothic', 'Darkwave', 'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream',
  'Southern Rock', 'Comedy', 'Cult', 'Gangsta', 'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle',
  'Native American', 'Cabaret', 'New Wave', 'Psychedelic', 'Rave', 'Showtunes', 'Trailer', 'Lo-Fi',
  'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock',
];

function syncsafe(buf, off) {
  return ((buf[off] & 0x7f) << 21) | ((buf[off + 1] & 0x7f) << 14) |
    ((buf[off + 2] & 0x7f) << 7) | (buf[off + 3] & 0x7f);
}

/** 0xFF 0x00 → 0xFF の unsynchronisation を戻す */
function deUnsync(buf) {
  const out = Buffer.alloc(buf.length);
  let j = 0;
  for (let i = 0; i < buf.length; i++) {
    out[j++] = buf[i];
    if (buf[i] === 0xff && buf[i + 1] === 0x00) i++;
  }
  return out.subarray(0, j);
}

function resolveGenre(s) {
  const m = /^\(?(\d+)\)?$/.exec(s.trim());
  if (m) return GENRES[Number(m[1])] ?? s;
  return s;
}

/** エンコーディングに応じた NUL 終端位置を探し、終端直後のオフセットを返す */
function skipTerminatedString(data, start, encodingByte) {
  if (encodingByte === 1 || encodingByte === 2) { // UTF-16: 2 バイト単位の 0x0000
    for (let i = start; i + 1 < data.length; i += 2) {
      if (data[i] === 0 && data[i + 1] === 0) return i + 2;
    }
    return data.length;
  }
  const idx = data.indexOf(0, start);
  return idx === -1 ? data.length : idx + 1;
}

const TEXT_FRAMES = {
  // v2.3 / v2.4
  TIT2: 'title', TPE1: 'artist', TPE2: 'albumArtist', TALB: 'album',
  TCON: 'genre', TRCK: 'track', TPOS: 'disc', TYER: 'year', TDRC: 'year',
  // v2.2
  TT2: 'title', TP1: 'artist', TP2: 'albumArtist', TAL: 'album',
  TCO: 'genre', TRK: 'track', TPA: 'disc', TYE: 'year',
};

/**
 * ID3v2 タグをパースする。
 * @param {Buffer} buf "ID3" マジックから始まるバッファ (タグ全体を含むこと)
 * @param {number} fileOffset buf[0] のファイル内絶対オフセット (アートワーク位置計算用)
 * @returns {{tags: object, art: object|null, tagSize: number}|null}
 */
export function parseId3(buf, fileOffset = 0) {
  if (buf.length < 10 || buf.toString('ascii', 0, 3) !== 'ID3') return null;
  const major = buf[3];
  const flags = buf[5];
  const tagSize = syncsafe(buf, 6);
  const tagEnd = Math.min(10 + tagSize, buf.length);

  let body = buf.subarray(10, tagEnd);
  let unsyncedGlobally = false;
  if ((flags & 0x80) && major < 4) { // v2.4 は通常フレーム単位
    body = deUnsync(body);
    unsyncedGlobally = true;
  }

  let pos = 0;
  // 拡張ヘッダをスキップ
  if (flags & 0x40) {
    if (major === 3 && body.length >= 4) pos = 4 + body.readUInt32BE(0);
    else if (major === 4 && body.length >= 4) pos = syncsafe(body, 0);
  }

  const tags = {};
  let art = null;
  const idLen = major === 2 ? 3 : 4;
  const hdrLen = major === 2 ? 6 : 10;

  while (pos + hdrLen <= body.length) {
    if (body[pos] === 0) break; // パディング領域
    const id = body.toString('ascii', pos, pos + idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break;

    let size, frameFlags = 0;
    if (major === 2) {
      size = (body[pos + 3] << 16) | (body[pos + 4] << 8) | body[pos + 5];
    } else {
      size = major === 4 ? syncsafe(body, pos + idLen) : body.readUInt32BE(pos + idLen);
      frameFlags = body.readUInt16BE(pos + idLen + 4);
    }
    const dataStart = pos + hdrLen;
    if (size < 0 || dataStart + size > body.length) break;
    let data = body.subarray(dataStart, dataStart + size);
    pos = dataStart + size;

    // 圧縮・暗号化フレームは扱わない
    if (major === 3 && (frameFlags & 0x00c0)) continue;
    if (major === 4 && (frameFlags & 0x000c)) continue;

    let frameUnsynced = false;
    if (major === 4 && (frameFlags & 0x0002)) { data = deUnsync(data); frameUnsynced = true; }
    if (major === 4 && (frameFlags & 0x0001)) data = data.subarray(4); // data length indicator

    const field = TEXT_FRAMES[id];
    if (field && data.length >= 1) {
      const value = decodeId3Text(data[0], data.subarray(1));
      if (value && tags[field] === undefined) {
        tags[field] = field === 'genre' ? resolveGenre(value) : value;
      }
      continue;
    }

    if ((id === 'APIC' || id === 'PIC') && data.length > 4 && !art) {
      // unsync がかかっているとファイル内オフセットが元データとずれるため、
      // その場合は画像バイト列自体を保持する
      const enc = data[0];
      let p, mime;
      if (id === 'PIC') { // v2.2: 画像フォーマット 3 文字
        const fmt = data.toString('ascii', 1, 4).toLowerCase();
        mime = fmt === 'png' ? 'image/png' : 'image/jpeg';
        p = 4;
      } else {
        const mimeEnd = data.indexOf(0, 1);
        if (mimeEnd === -1) continue;
        mime = data.toString('ascii', 1, mimeEnd) || 'image/jpeg';
        p = mimeEnd + 1;
      }
      p += 1; // picture type
      p = skipTerminatedString(data, p, enc); // description
      if (p >= data.length) continue;
      if (unsyncedGlobally || frameUnsynced) {
        art = { mime, buffer: Buffer.from(data.subarray(p)) };
      } else {
        // data length indicator を剥がした場合はその 4 バイト分ずれる
        const skipped = major === 4 && (frameFlags & 0x0001) ? 4 : 0;
        art = {
          mime,
          offset: fileOffset + 10 + dataStart + skipped + p,
          length: data.length - p,
        };
      }
    }
  }

  if (tags.track !== undefined) tags.track = parseTrackNumber(tags.track);
  if (tags.disc !== undefined) tags.disc = parseTrackNumber(tags.disc);
  if (tags.year !== undefined) tags.year = parseYear(tags.year);
  return { tags, art, tagSize: 10 + tagSize };
}
