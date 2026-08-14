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
import { readFileSync } from 'node:fs';
import { open, stat, readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { scanLibrary, deleteLibraryCache, IGNORED_DIRS } from './lib/scan.js';
import { MIME_BY_EXT } from './lib/metadata.js';
import { readAt } from './lib/util.js';
import { listRemovableVolumes } from './lib/devices.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'server', 'static', 'public');

// アプリのバージョン (package.json から。UI 表示用)
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version ?? '';
  } catch {
    return '';
  }
})();

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
  const opts = { dir: null, port: 8323, host: '127.0.0.1', cache: true, sources: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') opts.port = Number(argv[++i]);
    else if (a === '--host') opts.host = argv[++i];
    else if (a === '--source') opts.sources.push(argv[++i]);
    else if (a === '--no-cache') opts.cache = false;
    else if (a === '--open') opts.open = true;
    else if (a === '--exit-on-close') opts.exitOnClose = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (!a.startsWith('-') && !opts.dir) opts.dir = a;
  }
  return opts;
}

/** 既定ブラウザで URL を開く (macOS / Windows / Linux) */
function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? ['open', url]
    : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url]
    : ['xdg-open', url];
  spawn(cmd[0], cmd.slice(1), { stdio: 'ignore', detached: true }).unref();
}

// ---- ライブラリ状態 -------------------------------------------------------

const state = {
  rootDir: null,
  sources: new Map(),        // srcId -> {id, dir, label, removable, tracks, errors}
  tracks: [],
  byId: new Map(),
  scanning: false,
  scannedAt: null,
  ffmpeg: false,
  folderArtCache: new Map(), // dir -> ファイル名 or null
  deviceLister: listRemovableVolumes,
};

function sourceId(dir) {
  return createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 12);
}

// ---- 固定ライブラリの記録 ---------------------------------------------------
// UI で「固定」にしたデバイス/NAS のパスを設定ファイルに残し、次回起動時に
// --source 指定と同じように自動で読み込む。固定ソースはスキャンキャッシュも使う。

function configDir() {
  return process.env.MACCA_CONFIG_DIR || path.join(os.homedir(), '.config', 'macca');
}

function sourcesFile() {
  return path.join(configDir(), 'sources.json');
}

function loadPinnedDirs() {
  try {
    const json = JSON.parse(readFileSync(sourcesFile(), 'utf8'));
    return Array.isArray(json?.pinned) ? json.pinned.filter((d) => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

// UI 設定 (音量正規化・デバッグ表示など)。ポートが変わっても引き継がれるよう
// ブラウザの localStorage ではなくサーバ側に保存する
function settingsFile() {
  return path.join(configDir(), 'settings.json');
}

function loadSettingsFile() {
  try {
    const json = JSON.parse(readFileSync(settingsFile(), 'utf8'));
    return json && typeof json === 'object' && !Array.isArray(json) ? json : {};
  } catch {
    return {};
  }
}

async function saveSettingsFile(obj) {
  try {
    await mkdir(configDir(), { recursive: true });
    await writeFile(settingsFile(), JSON.stringify(obj, null, 2) + '\n');
  } catch (err) {
    console.error(`設定の保存に失敗しました: ${err?.message ?? err}`);
  }
}

async function serveSettings(req, res) {
  if (req.method === 'GET') return sendJson(res, 200, loadSettingsFile());
  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return sendJson(res, 400, { error: '不正な設定' });
  }
  const merged = { ...loadSettingsFile(), ...body };
  await saveSettingsFile(merged);
  return sendJson(res, 200, merged);
}

async function savePinnedDirs() {
  const dirs = [...state.sources.values()].filter((s) => s.pinned).map((s) => s.dir);
  try {
    await mkdir(configDir(), { recursive: true });
    await writeFile(sourcesFile(), JSON.stringify({ pinned: dirs }, null, 2) + '\n');
  } catch (err) {
    console.error(`設定の保存に失敗しました: ${err?.message ?? err}`);
  }
}

/** 全ソースのトラックを一つの索引にまとめ直す */
function rebuildIndex() {
  state.tracks = [...state.sources.values()].flatMap((s) => s.tracks);
  state.byId = new Map(state.tracks.map((t) => [t.id, t]));
  state.scannedAt = new Date().toISOString();
  state.folderArtCache.clear();
}

async function scanSource(src, useCache = true) {
  console.log(`スキャン中: ${src.dir}`);
  const t0 = Date.now();
  // リムーバブルデバイスはディスクにキャッシュを残さない (プライバシー配慮:
  // 抜いた後のデバイスの中身の記録が Mac 側に残らないようにする)。
  // ただし「固定」にしたソースはユーザーが記録を許可したものとして扱う
  const { tracks, errors } = await scanLibrary(src.dir, {
    useCache: useCache && (!src.removable || src.pinned),
    onProgress: (done, total) => console.log(`  ... ${done}/${total}`),
  });
  src.tracks = tracks.map((t) => ({ ...t, src: src.id }));
  src.errors = errors;
  src.scanSeconds = (Date.now() - t0) / 1000; // 直近スキャンの所要 (デバッグ表示用)
  console.log(`スキャン完了: ${tracks.length} 曲 (${src.scanSeconds.toFixed(1)} 秒)` +
    (errors.length ? `, 読み取り失敗 ${errors.length} 件` : ''));
}

// スキャンジョブは裏で並行実行する (別デバイス同士を直列に待たせない)。
// API はジョブを起こしてすぐ応答し、フロントは scanning フラグを見て
// ライブラリを追いかける (UI を固めない)
let scanJobs = 0;

function queueScan(srcs, useCache = true) {
  scanJobs++;
  state.scanning = true;
  return (async () => {
    for (const src of srcs) {
      try {
        await scanSource(src, useCache);
      } catch (err) {
        // デバイスが抜かれた等: 空にして残す (UI から取り外し可能)
        src.tracks = [];
        src.errors = [{ path: src.dir, error: String(err?.message ?? err) }];
      }
    }
    rebuildIndex();
  })().finally(() => {
    if (--scanJobs === 0) state.scanning = false;
  });
}

async function rescan(useCache = true, srcs = null) {
  return queueScan(srcs ?? [...state.sources.values()], useCache);
}

function detectFfmpeg() {
  return new Promise((resolve) => {
    execFile('ffmpeg', ['-version'], (err) => resolve(!err));
  });
}

/**
 * iTunes / ミュージック.app の標準メディアフォルダ候補 (優先順)。
 * macOS と Windows のどちらのホームディレクトリ構成でも動く。
 */
export function defaultLibraryCandidates(home) {
  return [
    ['Music', 'Music', 'Media.localized', 'Music'], // macOS ミュージック.app (Catalina 以降)
    ['Music', 'Music', 'Media.localized'],
    ['Music', 'Apple Music', 'Media'],              // Windows 版 Apple Music アプリ
    ['Music', 'iTunes', 'iTunes Media', 'Music'],   // iTunes (Windows / 旧 macOS)
    ['Music', 'iTunes', 'iTunes Media'],
    ['Music', 'iTunes', 'iTunes Music'],            // さらに古い iTunes
    ['Music'],                                      // フォールバック: ミュージックフォルダ
  ].map((parts) => path.join(home, ...parts));
}

/** ディレクトリ未指定時に iTunes / ミュージックのライブラリを自動検出する */
async function findDefaultLibrary() {
  for (const dir of defaultLibraryCandidates(os.homedir())) {
    try {
      if ((await stat(dir)).isDirectory()) return dir;
    } catch {
      // 次の候補へ
    }
  }
  return null;
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

/** トラックの属すソース内の実ファイルパスを安全に解決する */
function resolveTrackPath(track) {
  const src = state.sources.get(track.src);
  if (!src) return null;
  const base = path.resolve(src.dir);
  const full = path.resolve(base, track.path);
  if (!full.startsWith(base + path.sep)) return null;
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
    src: t.src,
    path: t.path,
    ext: t.ext,
    size: t.size,
    mtime: t.mtime ?? 0,
    title: t.title,
    artist: t.artist,
    albumArtist: t.albumArtist,
    album: t.album,
    genre: t.genre,
    year: t.year,
    track: t.track,
    disc: t.disc,
    duration: t.duration,
    codec: t.codec,
    hasArt: Boolean(t.art),
  }));
  const sources = [...state.sources.values()].map((s) => ({
    id: s.id,
    dir: s.dir,
    label: s.label,
    removable: s.removable,
    pinned: Boolean(s.pinned),
    tracks: s.tracks.length,
    errors: s.errors.length,
    scanSeconds: s.scanSeconds ?? 0,
  }));
  sendJson(res, 200, {
    dir: state.rootDir,
    server: 'node', // サーバ実装の識別 (UI のバッジ表示用)
    version: VERSION,
    sources,
    scannedAt: state.scannedAt,
    scanning: state.scanning,
    ffmpeg: state.ffmpeg,
    errors: sources.reduce((n, s) => n + s.errors, 0),
    tracks,
  });
}

// ---- ブラウザ接続の監視 (--exit-on-close) ----------------------------------
// フロントが張る SSE 接続で「開いているページ数」を数え、全ページが閉じて
// 猶予時間が過ぎたらプロセスを終了する (ワンクリック起動のアプリ的な挙動)。

const presence = { clients: 0, exitTimer: null };
const EXIT_GRACE_MS = 8000; // リロード・画面遷移で誤終了しないための猶予

function servePresence(req, res, exitOnClose) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  presence.clients++;
  clearTimeout(presence.exitTimer);
  const keepalive = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(keepalive);
    presence.clients--;
    if (!exitOnClose || presence.clients > 0) return;
    clearTimeout(presence.exitTimer);
    presence.exitTimer = setTimeout(() => {
      if (presence.clients <= 0) {
        console.log('ブラウザが閉じられたため macca を終了します');
        process.exit(0);
      }
    }, EXIT_GRACE_MS);
  });
}

// ---- デバッグ用: プロセスのメモリ・CPU 使用率 --------------------------------

const statsState = { lastCpu: null, lastAt: 0 };

function serveStats(res) {
  const now = Date.now();
  const cpu = process.cpuUsage();
  let percent = -1;
  if (statsState.lastCpu && now > statsState.lastAt) {
    const usedMicros = (cpu.user + cpu.system) - (statsState.lastCpu.user + statsState.lastCpu.system);
    percent = Math.max(0, usedMicros / ((now - statsState.lastAt) * 1000) * 100);
  }
  statsState.lastCpu = cpu;
  statsState.lastAt = now;
  // clients: 開いているページ数 (ランチャーが Dock 再クリック時の挙動判定に使う)
  sendJson(res, 200, { rss: process.memoryUsage().rss, cpu: percent, clients: presence.clients });
}

// ---- デバイス (リムーバブルストレージ) -------------------------------------

async function serveDevices(res) {
  let volumes = [];
  try {
    volumes = await state.deviceLister();
  } catch {
    // 検出失敗は「デバイスなし」として扱う
  }
  // 取り外し (ホットスワップ) の後片付け: 実体が消えたリムーバブルソースは
  // ライブラリから外す。固定ソースは記録を残して曲だけ空にする
  let changed = false;
  for (const src of [...state.sources.values()]) {
    if (!src.removable) continue;
    try {
      await stat(src.dir);
      continue; // まだ生きている
    } catch { /* 消えた */ }
    if (src.pinned) {
      if (src.tracks.length > 0) {
        src.tracks = [];
        src.errors = [];
        changed = true;
      }
    } else {
      state.sources.delete(src.id);
      changed = true;
    }
  }
  if (changed) rebuildIndex();
  sendJson(res, 200, {
    devices: volumes.map((v) => ({
      id: sourceId(v.path),
      path: v.path,
      label: v.label,
      scanned: state.sources.has(sourceId(v.path)),
    })),
    // ライブラリ世代。フロントはこれの変化で「取り外し等でライブラリが
    // 変わった」ことを知り、曲・アルバム・アーティストの表示を取り直す
    scannedAt: state.scannedAt,
  });
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 64 * 1024) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data)); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

/** 接続中デバイス配下のフォルダ一覧 (フォルダ選択 UI 用)。デバイス外は見せない */
async function serveBrowse(res, query) {
  let volumes = [];
  try {
    volumes = await state.deviceLister();
  } catch { /* デバイスなし扱い */ }
  const reqPath = query.get('path');
  if (!reqPath) {
    // 最上位はデバイス一覧
    return sendJson(res, 200, {
      path: null,
      parent: null,
      dirs: volumes.map((v) => ({ name: v.label, path: path.resolve(v.path) })),
    });
  }
  const resolved = path.resolve(reqPath);
  const vol = volumes.find((v) => {
    const root = path.resolve(v.path);
    return root === resolved || resolved.startsWith(root + path.sep);
  });
  if (!vol) return sendJson(res, 400, { error: '接続中のデバイスではありません' });
  let dirs = [];
  try {
    dirs = (await readdir(resolved, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !IGNORED_DIRS.has(e.name.toLowerCase()))
      .map((e) => ({ name: e.name, path: path.join(resolved, e.name) }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  } catch {
    return sendJson(res, 400, { error: 'フォルダが見つかりません' });
  }
  const isRoot = path.resolve(vol.path) === resolved;
  sendJson(res, 200, { path: resolved, parent: isRoot ? null : path.dirname(resolved), dirs });
}

/** 接続中デバイス (またはその配下のフォルダ) をソースとして追加してスキャンする */
async function addDeviceSource(req, res, useCache) {
  const body = await readJsonBody(req);
  const reqPath = typeof body?.path === 'string' ? path.resolve(body.path) : null;
  let volumes = [];
  try {
    volumes = await state.deviceLister();
  } catch { /* 下の 400 へ */ }
  // 任意のパスをスキャンさせない: 現在マウント中のデバイスの配下に限定する
  const vol = reqPath && volumes.find((v) => {
    const root = path.resolve(v.path);
    return root === reqPath || reqPath.startsWith(root + path.sep);
  });
  if (!vol) return sendJson(res, 400, { error: '接続中のデバイスではありません' });
  const isRoot = path.resolve(vol.path) === reqPath;
  if (!isRoot) {
    try {
      if (!(await stat(reqPath)).isDirectory()) throw new Error();
    } catch {
      return sendJson(res, 400, { error: 'フォルダが見つかりません' });
    }
  }

  const id = sourceId(reqPath);
  const existing = state.sources.get(id);
  if (!existing) {
    const src = {
      id, dir: reqPath, label: isRoot ? vol.label : (path.basename(reqPath) || reqPath),
      removable: true, pinned: Boolean(body?.pin), tracks: [], errors: [],
    };
    state.sources.set(id, src);
    // スキャンで応答を待たせない: 裏で実行し、UI は scanning を見て合流する
    queueScan([src], useCache);
    if (src.pinned) await savePinnedDirs();
  } else if (body?.pin && existing.removable && !existing.pinned) {
    // スキャン済みデバイスを固定に昇格 (キャッシュ付きで読み直して次回起動を速くする)
    existing.pinned = true;
    queueScan([existing], useCache);
    await savePinnedDirs();
  }
  return serveLibrary(res);
}

/** ソースの固定 (次回起動時も自動読み込み) を切り替える */
async function setSourcePin(req, res, id, useCache) {
  const body = await readJsonBody(req);
  const src = state.sources.get(id);
  if (!src) return notFound(res, '不明なソース ID');
  if (!src.removable) return sendJson(res, 400, { error: 'メインライブラリは常に固定です' });
  const pinned = Boolean(body?.pinned);
  if (Boolean(src.pinned) !== pinned) {
    src.pinned = pinned;
    if (pinned) {
      // キャッシュ付きで読み直し、次回起動時に速く読めるようにする (裏で実行)
      queueScan([src], useCache);
    } else {
      // 固定解除: リムーバブルのプライバシー方針に戻すのでキャッシュを消す
      await deleteLibraryCache(src.dir);
    }
    await savePinnedDirs();
  }
  return serveLibrary(res);
}

/** ソース単体を再スキャンする (固定ソースの内容更新用。全体の /api/rescan より軽い) */
function rescanSource(res, id, useCache) {
  const src = state.sources.get(id);
  if (!src) return notFound(res, '不明なソース ID');
  // 裏で実行してすぐ応答する (UI は scanning を見て合流)
  queueScan([src], useCache);
  return serveLibrary(res);
}

/** デバイスソースを一覧から外す (ファイルには触れない) */
async function removeDeviceSource(res, id) {
  const src = state.sources.get(id);
  if (!src) return notFound(res, '不明なソース ID');
  if (!src.removable) return sendJson(res, 400, { error: 'メインライブラリは取り外せません' });
  state.sources.delete(id);
  rebuildIndex();
  if (src.pinned) {
    // 固定していた場合は記録とキャッシュも一緒に片付ける
    await deleteLibraryCache(src.dir);
    await savePinnedDirs();
  }
  return serveLibrary(res);
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

export async function createServer(rootDir, { useCache = true, deviceLister, extraSources = [], exitOnClose = false } = {}) {
  state.rootDir = path.resolve(rootDir);
  if (deviceLister) state.deviceLister = deviceLister;
  state.ffmpeg = await detectFfmpeg();
  state.sources.clear();
  const primary = {
    id: sourceId(state.rootDir), dir: state.rootDir,
    label: 'ライブラリ', removable: false, tracks: [], errors: [],
  };
  state.sources.set(primary.id, primary);
  // --source で明示追加されたフォルダ (MTP の FUSE マウント先や NAS など)
  for (const dir of extraSources) {
    const resolved = path.resolve(dir);
    const id = sourceId(resolved);
    if (state.sources.has(id)) continue;
    state.sources.set(id, {
      id, dir: resolved, label: path.basename(resolved) || resolved,
      removable: false, tracks: [], errors: [],
    });
  }
  // UI で「固定」にしたソースを設定から復元 (--source と同じ扱いで毎回読み込む)
  for (const dir of loadPinnedDirs()) {
    const resolved = path.resolve(dir);
    const id = sourceId(resolved);
    if (state.sources.has(id)) continue;
    state.sources.set(id, {
      id, dir: resolved, label: path.basename(resolved) || resolved,
      removable: true, pinned: true, tracks: [], errors: [],
    });
  }
  // 固定ソース (NAS 等) のスキャンで起動を待たせない: メインライブラリだけ先に
  // 読んでサーバを立ち上げ、固定ソースは裏でスキャンして合流させる
  const all = [...state.sources.values()];
  await rescan(useCache, all.filter((s) => !s.pinned));
  const deferred = all.filter((s) => s.pinned);
  if (deferred.length > 0) {
    rescan(useCache, deferred).catch(() => {});
  }

  // リムーバブルソース (SDカード等) を使用中はスリープさせない。
  // 無アクセスが続くと外部ドライブが止まり、次の再生開始が起床待ちになるため。
  // 同じ場所を読むと OS のキャッシュに当たって実デバイスに I/O が届かないので、
  // 毎回ランダムな曲のランダムな位置を 4KB だけ読んで物理アクセスを発生させる
  const keepAwake = setInterval(async () => {
    for (const src of state.sources.values()) {
      if (!src.removable || src.tracks.length === 0) continue;
      try {
        const t = src.tracks[Math.floor(Math.random() * src.tracks.length)];
        const fh = await open(path.join(src.dir, t.path), 'r');
        const off = t.size > 4096 ? Math.floor(Math.random() * (t.size - 4096)) : 0;
        await readAt(fh, off, 4096);
        await fh.close();
      } catch {
        // デバイスが抜かれている等: 無視
      }
    }
  }, 2 * 60 * 1000);
  keepAwake.unref?.();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = decodeURIComponent(url.pathname);

      if (p === '/api/library') return serveLibrary(res);
      if (p === '/api/rescan' && req.method === 'POST') {
        // 即応答して裏で実行 (UI は scanning フラグを見て合流する)
        rescan(useCache);
        return serveLibrary(res);
      }
      if (p === '/api/presence') return servePresence(req, res, exitOnClose);
      if (p === '/api/stats') return serveStats(res);
      if (p === '/api/devices') return serveDevices(res);
      if (p === '/api/browse') return serveBrowse(res, url.searchParams);
      if (p === '/api/settings' && (req.method === 'GET' || req.method === 'PUT')) {
        return serveSettings(req, res);
      }
      if (p === '/api/source' && req.method === 'POST') {
        return addDeviceSource(req, res, useCache);
      }
      const mp = /^\/api\/source\/([0-9a-f]{12})\/pin$/.exec(p);
      if (mp && req.method === 'POST') return setSourcePin(req, res, mp[1], useCache);
      const mr = /^\/api\/source\/([0-9a-f]{12})\/rescan$/.exec(p);
      if (mr && req.method === 'POST') return rescanSource(res, mr[1], useCache);
      const ms = /^\/api\/source\/([0-9a-f]{12})$/.exec(p);
      if (ms && req.method === 'DELETE') return removeDeviceSource(res, ms[1]);

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
    console.log('使い方: node server.js [音楽ディレクトリ] [--port 8323] [--host 127.0.0.1] [--source <dir>]... [--no-cache]');
    console.log('ディレクトリを省略すると iTunes / ミュージックのライブラリを自動検出します。');
    console.log('--source は追加のライブラリフォルダ (MTP の FUSE マウント先や NAS など)。複数指定可。');
    process.exit(0);
  }
  let dir = opts.dir;
  if (!dir) {
    dir = await findDefaultLibrary();
    if (!dir) {
      console.error('エラー: iTunes / ミュージックのライブラリが見つかりませんでした。');
      console.error('使い方: node server.js <音楽ディレクトリ> [--port 8323]');
      process.exit(1);
    }
    console.log(`ディレクトリ未指定のため自動検出: ${dir}`);
  }
  try {
    const st = await stat(dir);
    if (!st.isDirectory()) throw new Error();
  } catch {
    console.error(`エラー: ディレクトリが見つかりません: ${dir}`);
    console.error('使い方: node server.js <音楽ディレクトリ> [--port 8323]');
    process.exit(1);
  }

  const server = await createServer(dir, {
    useCache: opts.cache,
    extraSources: opts.sources,
    exitOnClose: opts.exitOnClose,
  });

  // ランチャー起動 (--exit-on-close) では重複起動を許す:
  // ポートが使用中なら次のポートへずらして新しいインスタンスを立てる
  let port = opts.port;
  let retries = opts.exitOnClose ? 20 : 0;
  const onError = (err) => {
    if (err.code === 'EADDRINUSE' && retries-- > 0) {
      port++;
      server.listen(port, opts.host);
      return;
    }
    console.error(`エラー: ポート ${port} で待ち受けできません (${err.code})`);
    process.exit(1);
  };
  server.on('error', onError);
  server.once('listening', () => {
    server.removeListener('error', onError);
    const url = `http://${opts.host === '0.0.0.0' ? '127.0.0.1' : opts.host}:${port}/`;
    console.log('');
    console.log(`  macca 起動: ${url}`);
    console.log(`  ライブラリ: ${path.resolve(dir)}`);
    console.log(`  ffmpeg: ${state.ffmpeg ? 'あり (非対応形式は WAV に変換して再生)' : 'なし (Safari 以外では ALAC/AIFF が再生できない場合があります)'}`);
    console.log('');
    if (opts.open) openBrowser(url);
  });
  server.listen(port, opts.host);
}
