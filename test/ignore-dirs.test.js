// NAS/OS のシステムフォルダ (ゴミ箱等) をスキャンから除外するテスト
// (server.js のライブラリ状態はモジュールシングルトンのため、
//  他のテストとはプロセスを分けて独立に検証する)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildWav } from './fixtures.js';
import { startExternalServer } from './go-harness.js';

let dir;
let server;
let base;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'macca-ignore-'));
  await writeFile(path.join(dir, 'main.wav'),
    buildWav({ title: '本物の曲', artist: 'A', album: 'X' }));
  // ゴミ箱・スナップショット類: 中の曲は拾ってはいけない
  for (const trash of ['@Recycle', '#recycle', '$RECYCLE.BIN', 'lost+found']) {
    await mkdir(path.join(dir, trash, 'sub'), { recursive: true });
    await writeFile(path.join(dir, trash, 'sub', 'old.wav'),
      buildWav({ title: `ゴミ箱の曲 ${trash}`, artist: 'A', album: 'X' }));
  }
  const external = await startExternalServer(dir);
  if (external) {
    server = external;
    base = external.base;
  } else {
    const { createServer } = await import('../server.js');
    const srv = await createServer(dir, { useCache: false, deviceLister: async () => [] });
    await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
    server = { base: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((r) => srv.close(r)) };
    base = server.base;
  }
});

after(async () => {
  await server?.close();
  await rm(dir, { recursive: true, force: true });
});

test('ゴミ箱等のシステムフォルダ内の曲はスキャンされない', async () => {
  const lib = await (await fetch(`${base}/api/library`)).json();
  assert.equal(lib.tracks.length, 1);
  assert.equal(lib.tracks[0].title, '本物の曲');
});
