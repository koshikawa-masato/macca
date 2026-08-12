// Node 実装と Go 実装のメタデータ出力パリティ検証。
// 意地悪ケース (Shift_JIS 偽装・UTF-16BE・ジャンル番号・VBR・MPEG2・ID3v2.2・unsync)
// を両実装に食わせて /api/library の出力が完全一致することを確認する。
// MACCA_SERVER_BIN が未設定のときは Node 実装の期待値検証のみ行う。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeParityFixtures, SJIS_TITLE, TINY_PNG } from './fixtures.js';
import { startExternalServer } from './go-harness.js';
import { createServer } from '../server.js';

let dir;
let nodeServer;
let nodeBase;
let goServer = null;

async function fetchTracks(base) {
  const lib = await (await fetch(`${base}/api/library`)).json();
  return lib.tracks.sort((a, b) => a.path.localeCompare(b.path));
}

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'macca-parity-'));
  await writeParityFixtures(dir);
  nodeServer = await createServer(dir, { useCache: false, deviceLister: async () => [] });
  await new Promise((resolve) => nodeServer.listen(0, '127.0.0.1', resolve));
  nodeBase = `http://127.0.0.1:${nodeServer.address().port}`;
  goServer = await startExternalServer(dir, {});
});

after(async () => {
  await new Promise((resolve) => nodeServer.close(resolve));
  await goServer?.close();
  await rm(dir, { recursive: true, force: true });
});

test('Node実装: 意地悪ケースのメタデータを正しく読む', async () => {
  const tracks = await fetchTracks(nodeBase);
  const byName = Object.fromEntries(tracks.map((t) => [t.path, t]));

  assert.equal(byName['sjis.mp3'].title, SJIS_TITLE, 'Latin-1と偽ったShift_JIS');
  assert.equal(byName['utf16be.mp3'].title, '大文字エンディアン', 'UTF-16BE (encoding=2)');
  assert.equal(byName['genre-paren.mp3'].genre, 'Pop', 'ジャンル番号 (13)');
  assert.equal(byName['genre-bare.mp3'].genre, 'Pop', 'ジャンル番号 13 (裸)');
  assert.ok(Math.abs(byName['vbr.mp3'].duration - (2000 * 1152) / 44100) < 0.01,
    `VBR: Xingフレーム数から算出 (${byName['vbr.mp3'].duration})`);
  const mpeg2 = byName['mpeg2.mp3'];
  assert.ok(mpeg2.duration > 1 && Math.abs(mpeg2.duration - (mpeg2.size * 8) / 144000) < 1,
    `MPEG2: V2ビットレート表で算出 (${mpeg2.duration})`);
  assert.equal(byName['v22.mp3'].title, '古いタグ', 'ID3v2.2');
  assert.equal(byName['v22.mp3'].artist, '旧世代', 'ID3v2.2 アーティスト');
  assert.equal(byName['unsync.mp3'].title, '非同期回避', 'unsynchronisation');
  assert.equal(byName['unsync.mp3'].hasArt, true, 'unsync タグ内のアートワーク');
  const m4a = byName['alac-tags.m4a'];
  assert.equal(m4a.title, '林檎可逆', 'MP4 ©nam');
  assert.equal(m4a.artist, '圧縮なし子', 'MP4 ©ART');
  assert.equal(m4a.album, 'ALAC集成', 'MP4 ©alb');
  assert.equal(m4a.track, 4, 'MP4 trkn');
  assert.equal(m4a.codec, 'alac', 'MP4 コーデック判別');
});

test('Go実装: /api/library の出力が Node と完全一致する', { skip: !process.env.MACCA_SERVER_BIN }, async () => {
  const nodeTracks = await fetchTracks(nodeBase);
  const goTracks = await fetchTracks(goServer.base);
  assert.equal(goTracks.length, nodeTracks.length);
  for (let i = 0; i < nodeTracks.length; i++) {
    assert.deepEqual(goTracks[i], nodeTracks[i], `トラック不一致: ${nodeTracks[i].path}`);
  }
});

test('Go実装: unsync タグのアートワークが Node と同一バイト列', { skip: !process.env.MACCA_SERVER_BIN }, async () => {
  const nodeTracks = await fetchTracks(nodeBase);
  const t = nodeTracks.find((x) => x.path === 'unsync.mp3');
  const [a, b] = await Promise.all([
    fetch(`${nodeBase}/api/artwork/${t.id}`).then((r) => r.arrayBuffer()),
    fetch(`${goServer.base}/api/artwork/${t.id}`).then((r) => r.arrayBuffer()),
  ]);
  assert.deepEqual(Buffer.from(a), Buffer.from(b));
  assert.deepEqual(Buffer.from(a), TINY_PNG, 'アートは元のPNGと一致');
});
