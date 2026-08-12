import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFixtures } from './fixtures.js';
import { readMetadata } from '../lib/metadata.js';
import { scanLibrary } from '../lib/scan.js';

let dir;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'macca-test-'));
  await writeFixtures(dir);
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function read(rel) {
  const p = path.join(dir, rel);
  const st = await stat(p);
  return readMetadata(p, st.size);
}

test('mp3: ID3v2.3 タグ (UTF-16 / 偽 latin1 / ジャンル番号)', async () => {
  const m = await read('アルバムA/01 テスト曲.mp3');
  assert.equal(m.tags.title, '流星ダンス');
  assert.equal(m.tags.artist, '高野テスト');
  assert.equal(m.tags.album, '夜のアルバム');
  assert.equal(m.tags.track, 1);
  assert.equal(m.tags.year, 2011);
  assert.equal(m.tags.genre, 'Rock'); // (17) → Rock
  assert.equal(m.codec, 'mp3');
  assert.ok(m.duration > 0 && m.duration < 5, `duration=${m.duration}`);
  assert.ok(m.art, 'アートワークあり');
  assert.equal(m.art.mime, 'image/png');
});

test('m4a: ALAC の MP4 atom メタデータ', async () => {
  const m = await read('アルバムA/02 alac.m4a');
  assert.equal(m.tags.title, '青い部屋');
  assert.equal(m.tags.artist, '高野テスト');
  assert.equal(m.tags.album, '夜のアルバム');
  assert.equal(m.tags.track, 2);
  assert.equal(m.tags.year, 2012);
  assert.equal(m.codec, 'alac');
  assert.equal(Math.round(m.duration), 30);
  assert.ok(m.art);
  assert.equal(m.art.mime, 'image/png');
});

test('aiff: COMM の再生時間と ID3 チャンク', async () => {
  const m = await read('aiff-song.aiff');
  assert.equal(m.tags.title, '海辺のメモ');
  assert.equal(m.tags.artist, '相原テスト');
  assert.equal(m.codec, 'aiff');
  assert.equal(Math.round(m.duration), 2);
  assert.ok(m.art);
});

test('flac: STREAMINFO / VORBIS_COMMENT / PICTURE', async () => {
  const m = await read('flac-song.flac');
  assert.equal(m.tags.title, '無圧縮の朝');
  assert.equal(m.tags.artist, '相原テスト');
  assert.equal(m.tags.track, 1);
  assert.equal(m.codec, 'flac');
  assert.equal(Math.round(m.duration), 10);
  assert.ok(m.art);
});

test('wav: LIST INFO タグと再生時間', async () => {
  const m = await read('wav-song.wav');
  assert.equal(m.tags.title, 'PCM散歩');
  assert.equal(m.tags.artist, 'ウェーブ');
  assert.equal(m.tags.album, 'WAV集');
  assert.equal(m.codec, 'pcm');
  assert.equal(Math.round(m.duration), 1);
});

test('タグなし mp3: ファイル名からのフォールバック', async () => {
  const m = await read('NoTag Artist - 名無しの曲.mp3');
  assert.equal(m.tags.artist, 'NoTag Artist');
  assert.equal(m.tags.title, '名無しの曲');
});

test('scanLibrary: 全ファイルを列挙し既定順に並べる', async () => {
  const { tracks, errors } = await scanLibrary(dir, { useCache: false });
  assert.equal(errors.length, 0);
  assert.equal(tracks.length, 6);
  const ids = new Set(tracks.map((t) => t.id));
  assert.equal(ids.size, 6, 'ID は一意');
  const alac = tracks.find((t) => t.ext === '.m4a');
  assert.equal(alac.codec, 'alac');
  assert.equal(alac.title, '青い部屋');
});
