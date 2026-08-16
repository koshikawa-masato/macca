// スキャン後にファイルが差し替え・削除された場合の /api/stream の応答
// - 大きさ or 更新時刻が索引と食い違う → 409 (別の曲を鳴らさない)
// - ファイルが消えた → 404
// - 再スキャン後は新しい内容で 200 に戻る
// (server.js のライブラリ状態はモジュールシングルトンのため別プロセスで検証する)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, unlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildWav } from './fixtures.js';
import { startExternalServer } from './go-harness.js';

let dir;
let server;
let base;

async function library() {
  return (await fetch(`${base}/api/library`)).json();
}

async function rescanAndWait() {
  const res = await fetch(`${base}/api/rescan`, { method: 'POST' });
  assert.equal(res.status, 200);
  for (let i = 0; i < 100; i++) {
    const lib = await library();
    if (!lib.scanning) return lib;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('rescan did not finish');
}

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'macca-stale-'));
  await writeFile(path.join(dir, 'a.wav'), buildWav({ title: '曲A', artist: 'X', album: '差し替えテスト' }));
  await writeFile(path.join(dir, 'b.wav'), buildWav({ title: '曲B', artist: 'X', album: '差し替えテスト' }));
  await writeFile(path.join(dir, 'c.wav'), buildWav({ title: '曲C', artist: 'X', album: '差し替えテスト' }));
  const external = await startExternalServer(dir);
  if (external) {
    server = external;
    base = external.base;
  } else {
    const { createServer } = await import('../server.js');
    const srv = await createServer(dir, { useCache: false });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    server = { close: () => new Promise((resolve) => srv.close(resolve)) };
    base = `http://127.0.0.1:${srv.address().port}`;
  }
});

after(async () => {
  await server?.close();
  await rm(dir, { recursive: true, force: true });
});

test('索引どおりのファイルは 200 で配信される', async () => {
  const lib = await library();
  assert.equal(lib.tracks.length, 3);
  const a = lib.tracks.find((t) => t.title === '曲A');
  const res = await fetch(`${base}/api/stream/${a.id}`);
  assert.equal(res.status, 200);
  assert.equal(Number(res.headers.get('content-length')), a.size);
  await res.arrayBuffer();
});

test('スキャン後に差し替えられたファイル (大きさが変わった) は 409', async () => {
  const lib = await library();
  const a = lib.tracks.find((t) => t.title === '曲A');
  // 別の曲 (長さも違う) で上書き
  await writeFile(path.join(dir, 'a.wav'),
    buildWav({ title: '別の曲', artist: 'Y', album: '差し替えテスト', seconds: 2 }));
  const res = await fetch(`${base}/api/stream/${a.id}`);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'changed');
  const head = await fetch(`${base}/api/stream/${a.id}`, { method: 'HEAD' });
  assert.equal(head.status, 409);
});

test('中身が同じでも更新時刻が変わっていれば 409 (上書き検知)', async () => {
  const lib = await library();
  const c = lib.tracks.find((t) => t.title === '曲C');
  const past = new Date(Date.now() - 24 * 3600 * 1000);
  await utimes(path.join(dir, 'c.wav'), past, past);
  const res = await fetch(`${base}/api/stream/${c.id}`);
  assert.equal(res.status, 409);
});

test('削除されたファイルは 404', async () => {
  const lib = await library();
  const b = lib.tracks.find((t) => t.title === '曲B');
  await unlink(path.join(dir, 'b.wav'));
  const res = await fetch(`${base}/api/stream/${b.id}`);
  assert.equal(res.status, 404);
});

test('再スキャン後は新しい内容が同じ ID で配信され、消えた曲は索引から外れる', async () => {
  const before = await library();
  const oldA = before.tracks.find((t) => t.title === '曲A');
  const lib = await rescanAndWait();
  assert.equal(lib.tracks.length, 2);
  assert.ok(!lib.tracks.some((t) => t.title === '曲B'), '削除した曲は消える');
  const a = lib.tracks.find((t) => t.title === '別の曲');
  assert.ok(a, '差し替え後の曲名で索引される');
  assert.equal(a.id, oldA.id, 'パスが同じなら ID は変わらない');
  const res = await fetch(`${base}/api/stream/${a.id}`);
  assert.equal(res.status, 200);
  assert.equal(Number(res.headers.get('content-length')), a.size);
  await res.arrayBuffer();
  const c = lib.tracks.find((t) => t.title === '曲C');
  assert.equal((await fetch(`${base}/api/stream/${c.id}`, { method: 'HEAD' })).status, 200);
});
