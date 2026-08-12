// 拡張子ごとのメタデータ抽出ディスパッチャ

import { open } from 'node:fs/promises';
import path from 'node:path';
import { readAt } from './util.js';
import { parseId3 } from './id3.js';
import { estimateMp3Duration } from './mp3.js';
import { parseMp4 } from './mp4.js';
import { parseFlac } from './flac.js';
import { parseAiff } from './aiff.js';
import { parseWav } from './wav.js';

export const SUPPORTED_EXTENSIONS = new Set([
  '.mp3', '.m4a', '.m4b', '.aac', '.aif', '.aiff', '.aifc', '.flac', '.wav', '.ogg', '.oga', '.opus',
]);

export const MIME_BY_EXT = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.aac': 'audio/aac',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.aifc': 'audio/aiff',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg; codecs=opus',
};

async function parseMp3File(fh, fileSize) {
  // 先頭の ID3v2 タグ
  const head = await readAt(fh, 0, 10);
  let tags = {};
  let art = null;
  let audioStart = 0;
  if (head.length === 10 && head.toString('ascii', 0, 3) === 'ID3') {
    const tagSize = 10 + (((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) |
      ((head[8] & 0x7f) << 7) | (head[9] & 0x7f));
    const buf = await readAt(fh, 0, Math.min(tagSize, 16 * 1024 * 1024));
    const parsed = parseId3(buf, 0);
    if (parsed) {
      tags = parsed.tags;
      art = parsed.art;
    }
    audioStart = tagSize;
  }
  const frameBuf = await readAt(fh, audioStart, 64 * 1024);
  const duration = estimateMp3Duration(frameBuf, Math.max(0, fileSize - audioStart));
  return { tags, duration, codec: 'mp3', art };
}

/** ファイル名 "01 Artist - Title.ext" などからのフォールバック */
function fallbackFromFilename(filePath) {
  let base = path.basename(filePath, path.extname(filePath));
  base = base.replace(/^\d{1,3}[\s._-]+/, ''); // 先頭のトラック番号
  const m = /^(.+?)\s+-\s+(.+)$/.exec(base);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  return { title: base.trim() };
}

/**
 * 音声ファイルのメタデータを読む。
 * @returns {{tags: object, duration: number|null, codec: string|null, art: object|null}}
 */
export async function readMetadata(filePath, fileSize) {
  const ext = path.extname(filePath).toLowerCase();
  let fh = null;
  let result = null;
  try {
    fh = await open(filePath, 'r');
    if (ext === '.mp3' || ext === '.aac') {
      result = await parseMp3File(fh, fileSize);
    } else if (ext === '.m4a' || ext === '.m4b') {
      result = await parseMp4(fh, fileSize);
    } else if (ext === '.flac') {
      result = await parseFlac(fh, fileSize);
    } else if (ext === '.aif' || ext === '.aiff' || ext === '.aifc') {
      result = await parseAiff(fh, fileSize);
    } else if (ext === '.wav') {
      result = await parseWav(fh, fileSize);
    }
    // .ogg/.opus はパーサ未実装: ファイル名フォールバックのみ
  } catch {
    result = null;
  } finally {
    await fh?.close().catch(() => {});
  }

  const r = result ?? { tags: {}, duration: null, codec: null, art: null };
  // unsync 解除などでバイト列として取り出したアートワークは JSON キャッシュ可能な形にする
  if (r.art?.buffer) {
    r.art = { mime: r.art.mime, dataBase64: r.art.buffer.toString('base64') };
  }
  if (!r.tags.title) {
    Object.assign(r.tags, { ...fallbackFromFilename(filePath), ...r.tags });
  }
  return r;
}
