// ライブラリスキャン: 音楽ディレクトリを再帰走査してメタデータを収集する。
// mtime + サイズが一致するファイルはキャッシュを再利用するので 2 回目以降は速い。

import { readdir, stat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { readMetadata, SUPPORTED_EXTENSIONS } from './metadata.js';

const CACHE_DIR = path.join(os.homedir(), '.cache', 'macca');
const CONCURRENCY = 8;

function trackId(relPath) {
  return createHash('sha1').update(relPath).digest('hex').slice(0, 16);
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(full);
    } else if (e.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(e.name).toLowerCase())) {
      yield full;
    }
  }
}

function cacheFileFor(rootDir) {
  const key = createHash('sha1').update(path.resolve(rootDir)).digest('hex').slice(0, 12);
  return path.join(CACHE_DIR, `library-${key}.json`);
}

async function loadCache(rootDir) {
  try {
    const raw = await readFile(cacheFileFor(rootDir), 'utf8');
    const json = JSON.parse(raw);
    return json.version === 1 && json.files ? json.files : {};
  } catch {
    return {};
  }
}

async function saveCache(rootDir, files) {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(cacheFileFor(rootDir), JSON.stringify({ version: 1, files }));
  } catch {
    // キャッシュ保存失敗は無視 (次回フルスキャンになるだけ)
  }
}

/**
 * @param {string} rootDir 音楽ディレクトリ
 * @param {{useCache?: boolean, onProgress?: (done: number) => void}} opts
 * @returns {Promise<{tracks: Array, errors: Array}>}
 */
export async function scanLibrary(rootDir, opts = {}) {
  const { useCache = true, onProgress } = opts;
  const cache = useCache ? await loadCache(rootDir) : {};
  const newCache = {};
  const tracks = [];
  const errors = [];

  const paths = [];
  for await (const p of walk(rootDir)) paths.push(p);
  paths.sort();

  let done = 0;
  let index = 0;
  async function worker() {
    while (index < paths.length) {
      const filePath = paths[index++];
      const relPath = path.relative(rootDir, filePath);
      try {
        const st = await stat(filePath);
        const cached = cache[relPath];
        let meta;
        if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
          meta = cached.meta;
        } else {
          meta = await readMetadata(filePath, st.size);
        }
        newCache[relPath] = { mtimeMs: st.mtimeMs, size: st.size, meta };
        const ext = path.extname(filePath).toLowerCase();
        tracks.push({
          id: trackId(relPath),
          path: relPath,
          ext,
          size: st.size,
          title: meta.tags.title ?? path.basename(relPath, ext),
          artist: meta.tags.artist ?? null,
          albumArtist: meta.tags.albumArtist ?? null,
          album: meta.tags.album ?? null,
          genre: meta.tags.genre ?? null,
          year: meta.tags.year ?? null,
          track: meta.tags.track ?? null,
          duration: meta.duration ?? null,
          codec: meta.codec ?? null,
          art: meta.art ?? null,
        });
      } catch (err) {
        errors.push({ path: relPath, error: String(err?.message ?? err) });
      }
      done++;
      if (onProgress && done % 200 === 0) onProgress(done, paths.length);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  if (useCache) await saveCache(rootDir, newCache);

  // 既定の並び: アーティスト → アルバム → トラック番号
  const collator = new Intl.Collator('ja');
  tracks.sort((a, b) =>
    collator.compare(a.artist ?? '', b.artist ?? '') ||
    collator.compare(a.album ?? '', b.album ?? '') ||
    (a.track ?? 9999) - (b.track ?? 9999) ||
    collator.compare(a.title, b.title));

  return { tracks, errors };
}
