#!/usr/bin/env node
// macca — iTunes 不要のローカル音楽ライブラリ管理・再生 Web アプリ
//
//   node server.js ~/Music/MyLibrary [--port 8323] [--host 127.0.0.1] [--no-cache]
//
// 依存パッケージなし (Node.js >= 18)。ffmpeg があれば、ブラウザが
// ネイティブ再生できない形式 (Chrome/Firefox での ALAC・AIFF など) を
// その場で WAV にロスレス変換してストリーミングする。

import http from 'node:http';
import { createReadStream } from 'node:fs';
import { open, stat, readdir, readFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { scanLibrary } from './lib/scan.js';
import { MIME_BY_EXT } from './lib/metadata.js';
import { readAt } from './lib/util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};

const COVER_NAMES = /^(cover|folder|front|album|jacket|artwork)\.(jpe?g|png)$/i;

// ---- CLI 引数 -------------------------------------------------------------

function parseArgs(argv) {
  const opts = { dir: null, port: 8323, host: '127.0.0.1', cache: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--host') opts.host = argv[++i];
    else if (a === '--no-cache') opts.cache = false;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (!a.startsWith('-') && !opts.dir) opts.dir = a;
  }
  return opts;
}

// ---- ライブラリ状態 -------------------------------------------------------

const state = {
  rootDir: null,
  tracks: [],
  byId: new Map(),
  errors: [],
  scanning: false,
  scannedAt: null,
  ffmpeg: false,
  folderArtCache: new Map(), // dir -> ファイル名 or null
};

async function rescan(useCache = true) {
  if (state.scanning) return;
  state.scanning = true;
  try {
    console.log(`スキャン中: ${state.rootDir}`);
    const t0 = Date.now();
    const { tracks, errors } = await scanLibrary(state.rootDir, {
      useCache,
      onProgress: (done, total) => console.log(`  ... ${done}/${total}`),
    });
    state.tracks = tracks;
    state.byId = new Map(tracks.map((t) => [t.id, t]));
    state.errors = errors;
    state.scannedAt = new Date().toISOString();
    state.folderArtCache.clear();
    console.log(`スキャン完了: ${tracks.length} 曲 (${((Date.now() - t0) / 1000).toFixed(1)} 秒)` +
      (errors.length ? `, 読み取り失敗 ${errors.length} 件` : ''));
  } finally {
    state.scanning = false;
  }
}

function detectFfmpeg() {
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-version'], (err) => resolve(!err));
  });
}

// ---- レスポンスヘルパ -----------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function notFound(res, msg = 'not found') {
  sendJson(res, 404, { error: msg });
}

/** ライブラリ内の実ファイルパスを安全に解決する */
function resolveTrackPath(track) {
  const full = path.resolve(state.rootDir, track.path);
  if (!full.startsWith(path.resolve(state.rootDir) + path.sep)) return null;
  return full;
}

// ---- ルート実装 -----------------------------------------------------------

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const full = path.resolve(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR + path.sep) && full !== path.join(PUBLIC_DIR, 'index.html')) {
    return notFound(res);
  }
  try {
    const data = await readFile(full);
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[path.extname(full)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    notFound(res);
  }
}

function serveLibrary(res) {
  const tracks = state.tracks.map((t) => ({
    id: t.id,
    path: t.path,
    ext: t.ext,
    size: t.size,
    title: t.title,
    artist: t.artist,
    albumArtist: t.albumArtist,
    album: t.album,
    genre: t.genre,
    year: t.year,
    track: t.track,
    duration: t.duration,
    codec: t.codec,
    hasArt: Boolean(t.art),
  }));
  sendJson(res, 200, {
    dir: state.rootDir,
    scannedAt: state.scannedAt,
    scanning: state.scanning,
    ffmpeg: state.ffmpeg,
    errors: state.errors.length,
    tracks,
  });
}

async function serveStream(req, res, track, query) {
  const full = resolveTrackPath(track);
  if (!full) return notFound(res);

  if (query.get('transcode') === '1') {
    if (!state.ffmpeg) return sendJson(res, 501, { error: 'ffmpeg が見つかりません' });
    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Cache-Control': 'no-store',
    });
    const ff = spawn('ffmpeg', [
      '-v', 'error', '-i', full, '-map', '0:a:0',
      '-acodec', 'pcm_s16le', '-f', 'wav', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'inherit'] });
    ff.stdout.pipe(res);
    const kill = () => ff.kill('SIGKILL');
    res.on('close', kill);
    ff.on('error', () => res.destroy());
    return;
  }

  let st;
  try {
    st = await stat(full);
  } catch {
    return notFound(res, 'ファイルが見つかりません');
  }
  const total = st.size;
  const type = MIME_BY_EXT[track.ext] ?? 'application/octet-stream';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');

  let start = 0;
  let end = total - 1;
  let status = 200;
  if (range && (range[1] !== '' || range[2] !== '')) {
    if (range[1] === '') {
      start = Math.max(0, total - Number(range[2]));
    } else {
      start = Number(range[1]);
      if (range[2] !== '') end = Math.min(Number(range[2]), total - 1);
    }
    if (start > end || start >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      return res.end();
    }
    status = 206;
  }

  const headers = {
    'Content-Type': type,
    'Content-Length': end - start + 1,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();

  const stream = createReadStream(full, { start, end });
  stream.pipe(res);
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
}

/** 埋め込みアートワークがなければ、同じフォルダの cover.jpg 等を探す */
async function findFolderArt(dir) {
  if (state.folderArtCache.has(dir)) return state.folderArtCache.get(dir);
  let found = null;
  try {
    const entries = await readdir(dir);
    const name = entries.find((e) => COVER_NAMES.test(e));
    if (name) found = path.join(dir, name);
  } catch {
    // ignore
  }
  state.folderArtCache.set(dir, found);
  return found;
}

async function serveArtwork(res, track) {
  const art = track.art;
  const cacheHeaders = { 'Cache-Control': 'public, max-age=86400' };

  if (art?.dataBase64) {
    const buf = Buffer.from(art.dataBase64, 'base64');
    res.writeHead(200, { 'Content-Type': art.mime, ...cacheHeaders });
    return res.end(buf);
  }
  if (art?.offset !== undefined && art.length > 0 && art.length < 32 * 1024 * 1024) {
    const full = resolveTrackPath(track);
    if (!full) return notFound(res);
    let fh = null;
    try {
      fh = await open(full, 'r');
      const buf = await readAt(fh, art.offset, art.length);
      res.writeHead(200, { 'Content-Type': art.mime, ...cacheHeaders });
      return res.end(buf);
    } catch {
      return notFound(res);
    } finally {
      await fh?.close().catch(() => {});
    }
  }

  // フォルダ内のカバー画像にフォールバック
  const full = resolveTrackPath(track);
  if (full) {
    const coverPath = await findFolderArt(path.dirname(full));
    if (coverPath) {
      try {
        const data = await readFile(coverPath);
        const mime = /\.png$/i.test(coverPath) ? 'image/png' : 'image/jpeg';
        res.writeHead(200, { 'Content-Type': mime, ...cacheHeaders });
        return res.end(data);
      } catch {
        // fallthrough
      }
    }
  }
  notFound(res, 'アートワークなし');
}

// ---- サーバ起動 -----------------------------------------------------------

export async function createServer(rootDir, { useCache = true } = {}) {
  state.rootDir = path.resolve(rootDir);
  state.ffmpeg = await detectFfmpeg();
  await rescan(useCache);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = decodeURIComponent(url.pathname);

      if (p === '/api/library') return serveLibrary(res);
      if (p === '/api/rescan' && req.method === 'POST') {
        await rescan(useCache);
        return serveLibrary(res);
      }

      let m = /^\/api\/stream\/([0-9a-f]{16})$/.exec(p);
      if (m) {
        const track = state.byId.get(m[1]);
        if (!track) return notFound(res, '不明なトラック ID');
        return serveStream(req, res, track, url.searchParams);
      }
      m = /^\/api\/artwork\/([0-9a-f]{16})$/.exec(p);
      if (m) {
        const track = state.byId.get(m[1]);
        if (!track) return notFound(res, '不明なトラック ID');
        return serveArtwork(res, track);
      }

      if (p.startsWith('/api/')) return notFound(res);
      return serveStatic(req, res, p);
    } catch (err) {
      console.error(err);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.destroy();
    }
  });
  return server;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('使い方: node server.js <音楽ディレクトリ> [--port 8323] [--host 127.0.0.1] [--no-cache]');
    process.exit(0);
  }
  const dir = opts.dir ?? path.join(os.homedir(), 'Music');
  try {
    const st = await stat(dir);
    if (!st.isDirectory()) throw new Error();
  } catch {
    console.error(`エラー: ディレクトリが見つかりません: ${dir}`);
    console.error('使い方: node server.js <音楽ディレクトリ> [--port 8323]');
    process.exit(1);
  }

  const server = await createServer(dir, { useCache: opts.cache });
  server.listen(opts.port, opts.host, () => {
    console.log('');
    console.log(`  macca 起動: http://${opts.host}:${opts.port}/`);
    console.log(`  ライブラリ: ${path.resolve(dir)}`);
    console.log(`  ffmpeg: ${state.ffmpeg ? 'あり (非対応形式は WAV に変換して再生)' : 'なし (Safari 以外では ALAC/AIFF が再生できない場合があります)'}`);
    console.log('');
  });
}
