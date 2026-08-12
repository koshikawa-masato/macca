// --source (extraSources) による複数ライブラリ起動のテスト
// (server.js のライブラリ状態はモジュールシングルトンのため、
//  server.test.js とはプロセスを分けて独立に検証する)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildWav } from './fixtures.js';
import { createServer } from '../server.js';

let dir1;
let dir2;
let server;
let base;

before(async () => {
  dir1 = await mkdtemp(path.join(tmpdir(), 'macca-src1-'));
  dir2 = await mkdtemp(path.join(tmpdir(), 'macca-src2-'));
  await writeFile(path.join(dir1, 'main.wav'),
    buildWav({ title: 'メイン曲', artist: 'A', album: 'X' }));
  await writeFile(path.join(dir2, 'extra.wav'),
    buildWav({ title: '追加ソース曲', artist: 'B', album: 'Y' }));
  server = await createServer(dir1, {
    useCache: false,
    extraSources: [dir2],
    deviceLister: async () => [],
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir1, { recursive: true, force: true });
  await rm(dir2, { recursive: true, force: true });
});

test('--source: 追加フォルダがライブラリに統合される', async () => {
  const lib = await (await fetch(`${base}/api/library`)).json();
  assert.equal(lib.sources.length, 2);
  assert.ok(lib.tracks.some((t) => t.title === 'メイン曲'));
  const extra = lib.tracks.find((t) => t.title === '追加ソース曲');
  assert.ok(extra, '追加ソースの曲がある');

  // 追加ソースの曲もストリーミングできる
  const res = await fetch(`${base}/api/stream/${extra.id}`);
  assert.equal(res.status, 200);
  await res.arrayBuffer();

  // --source のソースはデバイスと違い取り外せない
  const src = lib.sources.find((s) => s.id === extra.src);
  assert.equal(src.removable, false);
  const del = await fetch(`${base}/api/source/${src.id}`, { method: 'DELETE' });
  assert.equal(del.status, 400);
});
