// テスト用の合成音声ファイル生成
// 実際のエンコーダなしで、各コンテナのメタデータ構造を正しく組み立てる。

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

// ---- WAV ------------------------------------------------------------------

export function buildWav({ title, artist, album, seconds = 1 }) {
  const sampleRate = 8000;
  const dataSize = sampleRate * 2 * seconds; // 16bit mono
  const data = Buffer.alloc(dataSize);
  for (let i = 0; i < dataSize / 2; i++) {
    data.writeInt16LE(Math.round(Math.sin(i * 0.2) * 8000), i * 2);
  }

  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);            // PCM
  fmt.writeUInt16LE(1, 2);            // mono
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * 2, 8); // byteRate
  fmt.writeUInt16LE(2, 12);
  fmt.writeUInt16LE(16, 14);

  const infoSub = (id, text) => {
    const t = Buffer.from(text + '\0', 'utf8');
    const padded = t.length % 2 ? Buffer.concat([t, Buffer.from([0])]) : t;
    const h = Buffer.alloc(8);
    h.write(id, 0, 'ascii');
    h.writeUInt32LE(t.length, 4);
    return Buffer.concat([h, padded]);
  };
  const infoBody = Buffer.concat([
    Buffer.from('INFO', 'ascii'),
    infoSub('INAM', title), infoSub('IART', artist), infoSub('IPRD', album),
  ]);

  const chunk = (id, body, le = true) => {
    const h = Buffer.alloc(8);
    h.write(id, 0, 'ascii');
    h.writeUInt32LE(body.length, 4);
    return Buffer.concat([h, body]);
  };
  const chunks = Buffer.concat([
    Buffer.from('WAVE', 'ascii'),
    chunk('fmt ', fmt), chunk('LIST', infoBody), chunk('data', data),
  ]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(chunks.length, 4);
  return Buffer.concat([riff, chunks]);
}

// ---- ID3v2.3 タグ (mp3 / aiff 用) ----------------------------------------

function id3Frame(id, body) {
  const h = Buffer.alloc(10);
  h.write(id, 0, 'ascii');
  h.writeUInt32BE(body.length, 4);
  return Buffer.concat([h, body]);
}

function id3TextFrame(id, text, encoding = 3) {
  let payload;
  if (Buffer.isBuffer(text)) {
    payload = text; // 生バイト列 (壊れタグ・Shift_JIS 等の再現用)
  } else if (encoding === 1) {
    payload = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  } else if (encoding === 2) {
    payload = Buffer.from(text, 'utf16le').swap16(); // UTF-16BE (BOM なし)
  } else if (encoding === 0) {
    payload = Buffer.from(text, 'utf8'); // 「latin1 と偽った UTF-8」の壊れタグを再現
  } else {
    payload = Buffer.from(text, 'utf8');
  }
  return id3Frame(id, Buffer.concat([Buffer.from([encoding]), payload]));
}

export function buildId3(tags, art = null, extraFrames = []) {
  const frames = [...extraFrames];
  if (tags.title) frames.push(id3TextFrame('TIT2', tags.title, 1));   // UTF-16
  if (tags.artist) frames.push(id3TextFrame('TPE1', tags.artist, 0)); // 偽 latin1
  if (tags.album) frames.push(id3TextFrame('TALB', tags.album, 3));   // UTF-8
  if (tags.track) frames.push(id3TextFrame('TRCK', String(tags.track), 0));
  if (tags.year) frames.push(id3TextFrame('TYER', String(tags.year), 0));
  if (tags.genre) frames.push(id3TextFrame('TCON', tags.genre, 0));
  if (art) {
    const body = Buffer.concat([
      Buffer.from([3]),                       // UTF-8
      Buffer.from('image/png\0', 'ascii'),
      Buffer.from([3]),                       // front cover
      Buffer.from('\0', 'ascii'),             // 空 description
      art,
    ]);
    frames.push(id3Frame('APIC', body));
  }
  const body = Buffer.concat(frames);
  const size = body.length;
  const header = Buffer.from([
    0x49, 0x44, 0x33, 3, 0, 0,
    (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f,
  ]);
  return Buffer.concat([header, body]);
}

export function buildMp3(tags, art = null, frames = 20, extraFrames = []) {
  const tag = buildId3(tags, art, extraFrames);
  // MPEG1 Layer3 128kbps 44.1kHz CBR フレーム
  const frameLen = Math.floor((144 * 128000) / 44100);
  const audio = Buffer.alloc(frameLen * frames);
  for (let i = 0; i < frames; i++) {
    audio[i * frameLen] = 0xff;
    audio[i * frameLen + 1] = 0xfb;
    audio[i * frameLen + 2] = 0x90;
    audio[i * frameLen + 3] = 0x00;
  }
  return Buffer.concat([tag, audio]);
}

/** Xing ヘッダ付き VBR MP3 (実時間 = frames * 1152 / 44100) */
export function buildVbrMp3(tags, xingFrames = 1000) {
  const tag = buildId3(tags);
  const frameLen = Math.floor((144 * 128000) / 44100);
  const frame = Buffer.alloc(frameLen);
  frame[0] = 0xff;
  frame[1] = 0xfb; // MPEG1 Layer3
  frame[2] = 0x90; // 128kbps, 44.1kHz
  frame[3] = 0x00; // ステレオ → サイド情報 32 バイト
  const xingPos = 4 + 32;
  frame.write('Xing', xingPos, 'ascii');
  frame.writeUInt32BE(0x01, xingPos + 4);       // FRAMES フラグ
  frame.writeUInt32BE(xingFrames, xingPos + 8); // フレーム数
  return Buffer.concat([tag, frame]);
}

/** MPEG2 Layer3 (22.05kHz 144kbps) の CBR MP3 */
export function buildMpeg2Mp3(tags, frames = 40) {
  const tag = buildId3(tags);
  const frameLen = Math.floor((72 * 144000) / 22050);
  const audio = Buffer.alloc(frameLen * frames);
  for (let i = 0; i < frames; i++) {
    audio[i * frameLen] = 0xff;
    audio[i * frameLen + 1] = 0xf3; // MPEG2, Layer3
    audio[i * frameLen + 2] = 0xd0; // bitrateIdx=13 (144kbps), srIdx=0 (22050)
    audio[i * frameLen + 3] = 0x00;
  }
  return Buffer.concat([tag, audio]);
}

/** ID3v2.2 タグ (3 文字 ID / 6 バイトフレームヘッダ) 付き MP3 */
export function buildId3v22Mp3(tags) {
  const frames = [];
  const frame22 = (id, text) => {
    const payload = Buffer.concat([Buffer.from([3]), Buffer.from(text, 'utf8')]);
    const h = Buffer.alloc(6);
    h.write(id, 0, 'ascii');
    h[3] = (payload.length >> 16) & 0xff;
    h[4] = (payload.length >> 8) & 0xff;
    h[5] = payload.length & 0xff;
    return Buffer.concat([h, payload]);
  };
  if (tags.title) frames.push(frame22('TT2', tags.title));
  if (tags.artist) frames.push(frame22('TP1', tags.artist));
  if (tags.album) frames.push(frame22('TAL', tags.album));
  const body = Buffer.concat(frames);
  const header = Buffer.from([
    0x49, 0x44, 0x33, 2, 0, 0,
    (body.length >> 21) & 0x7f, (body.length >> 14) & 0x7f,
    (body.length >> 7) & 0x7f, body.length & 0x7f,
  ]);
  const frameLen = Math.floor((144 * 128000) / 44100);
  const audio = Buffer.alloc(frameLen * 10);
  for (let i = 0; i < 10; i++) {
    audio[i * frameLen] = 0xff;
    audio[i * frameLen + 1] = 0xfb;
    audio[i * frameLen + 2] = 0x90;
  }
  return Buffer.concat([header, body, audio]);
}

/** タグ全体に unsynchronisation (0xFF → 0xFF 0x00) をかけた ID3v2.3 MP3 */
export function buildUnsyncMp3(tags, art = null) {
  const normal = buildId3(tags, art);
  const body = normal.subarray(10);
  // 0xFF の後に 0x00 を挿入
  const parts = [];
  for (let i = 0; i < body.length; i++) {
    parts.push(body.subarray(i, i + 1));
    if (body[i] === 0xff) parts.push(Buffer.from([0x00]));
  }
  const unsynced = Buffer.concat(parts);
  const size = unsynced.length;
  const header = Buffer.from([
    0x49, 0x44, 0x33, 3, 0, 0x80, // unsync フラグ
    (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f,
  ]);
  const frameLen = Math.floor((144 * 128000) / 44100);
  const audio = Buffer.alloc(frameLen * 10);
  for (let i = 0; i < 10; i++) {
    audio[i * frameLen] = 0xff;
    audio[i * frameLen + 1] = 0xfb;
    audio[i * frameLen + 2] = 0x90;
  }
  return Buffer.concat([header, unsynced, audio]);
}

// ---- AIFF -----------------------------------------------------------------

function ext80(value) {
  const b = Buffer.alloc(10);
  if (value > 0) {
    const e = Math.floor(Math.log2(value));
    const mant = value / 2 ** e; // [1, 2)
    b.writeUInt16BE(16383 + e, 0);
    const hi = Math.floor(mant * 2 ** 31);
    const lo = Math.floor((mant * 2 ** 31 - hi) * 2 ** 32);
    b.writeUInt32BE(hi >>> 0, 2);
    b.writeUInt32BE(lo >>> 0, 6);
  }
  return b;
}

export function buildAiff(tags, art = null, seconds = 2) {
  const sampleRate = 8000;
  const numFrames = sampleRate * seconds;
  const ssnd = Buffer.alloc(8 + numFrames * 2); // offset + blockSize + 16bit mono
  for (let i = 0; i < numFrames; i++) {
    ssnd.writeInt16BE(Math.round(Math.sin(i * 0.2) * 8000), 8 + i * 2);
  }

  const comm = Buffer.alloc(18);
  comm.writeUInt16BE(1, 0);            // channels
  comm.writeUInt32BE(numFrames, 2);
  comm.writeUInt16BE(16, 6);           // bits
  ext80(sampleRate).copy(comm, 8);

  const id3 = buildId3(tags, art);

  const chunk = (id, body) => {
    const h = Buffer.alloc(8);
    h.write(id, 0, 'ascii');
    h.writeUInt32BE(body.length, 4);
    const padded = body.length % 2 ? Buffer.concat([body, Buffer.from([0])]) : body;
    return Buffer.concat([h, padded]);
  };
  const chunks = Buffer.concat([
    Buffer.from('AIFF', 'ascii'),
    chunk('COMM', comm), chunk('SSND', ssnd), chunk('ID3 ', id3),
  ]);
  const form = Buffer.alloc(8);
  form.write('FORM', 0, 'ascii');
  form.writeUInt32BE(chunks.length, 4);
  return Buffer.concat([form, chunks]);
}

// ---- M4A (ALAC) -----------------------------------------------------------

function atom(type, ...payloads) {
  const body = Buffer.concat(payloads);
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + body.length, 0);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, body]);
}

function ilstText(key, text) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(1, 0); // type 1 = UTF-8
  return atom(key, atom('data', head, Buffer.from(text, 'utf8')));
}

export function buildM4a(tags, art = null, { codec = 'alac', durationSec = 30 } = {}) {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12);              // timescale
  mvhd.writeUInt32BE(durationSec * 1000, 16); // duration

  const stsdEntry = Buffer.alloc(36);
  stsdEntry.writeUInt32BE(36, 0);
  stsdEntry.write(codec, 4, 'latin1');
  const stsdBody = Buffer.alloc(8);
  stsdBody.writeUInt32BE(1, 4); // entry count
  const stsd = atom('stsd', stsdBody, stsdEntry);
  const trak = atom('trak', atom('mdia', atom('minf', atom('stbl', stsd))));

  const items = [];
  if (tags.title) items.push(ilstText('©nam', tags.title));
  if (tags.artist) items.push(ilstText('©ART', tags.artist));
  if (tags.album) items.push(ilstText('©alb', tags.album));
  if (tags.year) items.push(ilstText('©day', String(tags.year)));
  if (tags.track) {
    const head = Buffer.alloc(8); // type 0
    const num = Buffer.alloc(8);
    num.writeUInt16BE(tags.track, 2);
    num.writeUInt16BE(12, 4);
    items.push(atom('trkn', atom('data', head, num)));
  }
  if (art) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(14, 0); // 14 = PNG
    items.push(atom('covr', atom('data', head, art)));
  }
  const meta = atom('meta', Buffer.alloc(4), atom('ilst', ...items));

  const moov = atom('moov', atom('mvhd', mvhd), trak, atom('udta', meta));
  const ftyp = atom('ftyp', Buffer.from('M4A \x00\x00\x00\x00M4A mp42', 'latin1'));
  const mdat = atom('mdat', Buffer.alloc(1024));
  return Buffer.concat([ftyp, moov, mdat]);
}

// ---- FLAC -----------------------------------------------------------------

export function buildFlac(tags, art = null, { sampleRate = 44100, totalSamples = 441000 } = {}) {
  const blocks = [];

  const streaminfo = Buffer.alloc(34);
  streaminfo[10] = (sampleRate >> 12) & 0xff;
  streaminfo[11] = (sampleRate >> 4) & 0xff;
  streaminfo[12] = ((sampleRate & 0x0f) << 4) | (0 << 1); // mono
  streaminfo[13] = (15 << 4) | 0; // 16bit, totalSamples 上位 4bit = 0
  streaminfo.writeUInt32BE(totalSamples, 14);
  blocks.push([0, streaminfo]);

  const comments = [];
  if (tags.title) comments.push(`TITLE=${tags.title}`);
  if (tags.artist) comments.push(`ARTIST=${tags.artist}`);
  if (tags.album) comments.push(`ALBUM=${tags.album}`);
  if (tags.track) comments.push(`TRACKNUMBER=${tags.track}`);
  if (tags.year) comments.push(`DATE=${tags.year}`);
  const vendor = Buffer.from('macca-test', 'utf8');
  const parts = [Buffer.alloc(4), vendor, Buffer.alloc(4)];
  parts[0].writeUInt32LE(vendor.length, 0);
  parts[2].writeUInt32LE(comments.length, 0);
  for (const c of comments) {
    const cb = Buffer.from(c, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(cb.length, 0);
    parts.push(len, cb);
  }
  blocks.push([4, Buffer.concat(parts)]);

  if (art) {
    const mime = Buffer.from('image/png', 'ascii');
    const pic = Buffer.alloc(4 + 4 + mime.length + 4 + 16 + 4);
    let p = 0;
    pic.writeUInt32BE(3, p); p += 4;              // front cover
    pic.writeUInt32BE(mime.length, p); p += 4;
    mime.copy(pic, p); p += mime.length;
    pic.writeUInt32BE(0, p); p += 4;              // description len
    p += 16;                                      // w/h/depth/colors
    pic.writeUInt32BE(art.length, p);
    blocks.push([6, Buffer.concat([pic, art])]);
  }

  const out = [Buffer.from('fLaC', 'ascii')];
  blocks.forEach(([type, body], i) => {
    const h = Buffer.alloc(4);
    h[0] = type | (i === blocks.length - 1 ? 0x80 : 0);
    h[1] = (body.length >> 16) & 0xff;
    h[2] = (body.length >> 8) & 0xff;
    h[3] = body.length & 0xff;
    out.push(h, body);
  });
  return Buffer.concat(out);
}

// ---- フィクスチャ一式の書き出し -------------------------------------------

// 「テスト曲」の Shift_JIS バイト列 (encoding=0 と偽って格納する)
export const SJIS_TITLE = 'テスト曲';
const SJIS_TITLE_BYTES = Buffer.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67, 0x8b, 0xc8]);

export async function writeFixtures(dir) {
  await mkdir(path.join(dir, 'アルバムA'), { recursive: true });
  await writeFile(path.join(dir, 'アルバムA', '01 テスト曲.mp3'),
    buildMp3({ title: '流星ダンス', artist: '高野テスト', album: '夜のアルバム', track: 1, year: 2011, genre: '(17)' }, TINY_PNG));
  await writeFile(path.join(dir, 'アルバムA', '02 alac.m4a'),
    buildM4a({ title: '青い部屋', artist: '高野テスト', album: '夜のアルバム', track: 2, year: 2012 }, TINY_PNG));
  await writeFile(path.join(dir, 'aiff-song.aiff'),
    buildAiff({ title: '海辺のメモ', artist: '相原テスト', album: 'AIFF集', track: 3, year: 2020 }, TINY_PNG));
  await writeFile(path.join(dir, 'flac-song.flac'),
    buildFlac({ title: '無圧縮の朝', artist: '相原テスト', album: 'FLAC集', track: 1, year: 2023 }, TINY_PNG));
  await writeFile(path.join(dir, 'wav-song.wav'),
    buildWav({ title: 'PCM散歩', artist: 'ウェーブ', album: 'WAV集' }));
  await writeFile(path.join(dir, 'NoTag Artist - 名無しの曲.mp3'),
    buildMp3({}, null, 10));
}

/** パーサの互換検証用: 壊れタグ・特殊エンコーディング・VBR などの意地悪ケース */
export async function writeParityFixtures(dir) {
  await mkdir(dir, { recursive: true });
  // Latin-1 と偽った Shift_JIS タグ
  await writeFile(path.join(dir, 'sjis.mp3'), (() => {
    const tag = id3Frame('TIT2', Buffer.concat([Buffer.from([0]), SJIS_TITLE_BYTES]));
    const body = tag;
    const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0,
      (body.length >> 21) & 0x7f, (body.length >> 14) & 0x7f,
      (body.length >> 7) & 0x7f, body.length & 0x7f]);
    const frameLen = Math.floor((144 * 128000) / 44100);
    const audio = Buffer.alloc(frameLen * 10);
    for (let i = 0; i < 10; i++) {
      audio[i * frameLen] = 0xff;
      audio[i * frameLen + 1] = 0xfb;
      audio[i * frameLen + 2] = 0x90;
    }
    return Buffer.concat([header, body, audio]);
  })());
  // UTF-16BE (encoding=2)
  await writeFile(path.join(dir, 'utf16be.mp3'),
    buildMp3({ title: null }, null, 10, [id3TextFrame('TIT2', '大文字エンディアン', 2)]));
  // ジャンル番号参照 (括弧付き / 裸)
  await writeFile(path.join(dir, 'genre-paren.mp3'),
    buildMp3({ title: 'ジャンル括弧', genre: '(13)' }, null, 10));
  await writeFile(path.join(dir, 'genre-bare.mp3'),
    buildMp3({ title: 'ジャンル裸', genre: '13' }, null, 10));
  // VBR (Xing) と MPEG2
  await writeFile(path.join(dir, 'vbr.mp3'), buildVbrMp3({ title: 'VBR曲' }, 2000));
  await writeFile(path.join(dir, 'mpeg2.mp3'), buildMpeg2Mp3({ title: 'MPEG2曲' }));
  // ID3v2.2 と unsync
  await writeFile(path.join(dir, 'v22.mp3'),
    buildId3v22Mp3({ title: '古いタグ', artist: '旧世代', album: 'V22集' }));
  await writeFile(path.join(dir, 'unsync.mp3'),
    buildUnsyncMp3({ title: '非同期回避', artist: 'アンシンク' }, TINY_PNG));
}
