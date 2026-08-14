// 固定ライブラリ (デバイス/NAS のピン留め) のテスト
// - 固定すると設定ファイル (sources.json) に記録される
// - 再起動後は記録から自動でソースが復元される
// - 固定解除・取り外しで記録が消える
// (server.js のライブラリ状態はモジュールシングルトンのため、
//  他のテストとはプロセスを分けて独立に検証する)

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildWav } from './fixtures.js';
import { startExternalServer } from './go-harness.js';

let libDir;
let devDir;
let configDir;
let server;
let base;

async function startServer() {
  const devices = [{ path: devDir, label: 'TEST-SD' }];
  const external = await startExternalServer(libDir, { devices });
  if (external) return external;
  const { createServer } = await import('../server.js');
  const srv = await createServer(libDir, {
    useCache: false,
    deviceLister: async () => devices,
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${srv.address().port}`,
    close: () => new Promise((resolve) => srv.close(resolve)),
  };
}

async function readConfig() {
  try {
    return JSON.parse(await readFile(path.join(configDir, 'sources.json'), 'utf8'));
  } catch {
    return null;
  }
}

before(async () => {
  libDir = await mkdtemp(path.join(tmpdir(), 'macca-pin-lib-'));
  devDir = await mkdtemp(path.join(tmpdir(), 'macca-pin-dev-'));
  configDir = await mkdtemp(path.join(tmpdir(), 'macca-pin-cfg-'));
  process.env.MACCA_CONFIG_DIR = configDir;
  await writeFile(path.join(libDir, 'main.wav'),
    buildWav({ title: 'メイン曲', artist: 'A', album: 'X' }));
  await writeFile(path.join(devDir, 'sd.wav'),
    buildWav({ title: 'SDの曲', artist: 'B', album: 'Y' }));
  server = await startServer();
  base = server.base;
});

after(async () => {
  await server?.close();
  delete process.env.MACCA_CONFIG_DIR;
  await rm(libDir, { recursive: true, force: true });
  await rm(devDir, { recursive: true, force: true });
  await rm(configDir, { recursive: true, force: true });
});

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

/** スキャンは裏で走るので、条件が満たされるまでライブラリを追いかける */
async function waitForScan(pred) {
  let lib;
  for (let i = 0; i < 100; i++) {
    lib = await (await fetch(`${base}/api/library`)).json();
    if (!lib.scanning && pred(lib)) return lib;
    await new Promise((r) => setTimeout(r, 100));
  }
  return lib;
}

test('固定: スキャンと同時に固定でき、設定ファイルに記録される', async () => {
  const { status, json } = await postJson(`${base}/api/source`, { path: devDir, pin: true });
  assert.equal(status, 200);
  const src = json.sources.find((s) => s.dir === devDir);
  assert.ok(src, 'デバイスソースが追加されている');
  assert.equal(src.removable, true);
  assert.equal(src.pinned, true);
  // 記録は即座、スキャンは裏で走る
  assert.deepEqual(await readConfig(), { pinned: [devDir] });
  const lib = await waitForScan((l) => l.tracks.some((t) => t.title === 'SDの曲'));
  assert.ok(lib.tracks.some((t) => t.title === 'SDの曲'));
});

test('固定解除: pinned が消え、記録も空になる', async () => {
  const lib = await (await fetch(`${base}/api/library`)).json();
  const src = lib.sources.find((s) => s.dir === devDir);
  const { status, json } = await postJson(`${base}/api/source/${src.id}/pin`, { pinned: false });
  assert.equal(status, 200);
  assert.equal(json.sources.find((s) => s.dir === devDir).pinned, false);
  assert.deepEqual(await readConfig(), { pinned: [] });

  // 再固定して次のテスト (再起動復元) に備える
  const again = await postJson(`${base}/api/source/${src.id}/pin`, { pinned: true });
  assert.equal(again.status, 200);
  assert.equal(again.json.sources.find((s) => s.dir === devDir).pinned, true);
  assert.deepEqual(await readConfig(), { pinned: [devDir] });
});

test('メインライブラリの固定切り替えは 400', async () => {
  const lib = await (await fetch(`${base}/api/library`)).json();
  const main = lib.sources.find((s) => !s.removable);
  const { status } = await postJson(`${base}/api/source/${main.id}/pin`, { pinned: false });
  assert.equal(status, 400);
});

test('再起動: 固定ソースが記録から自動で復元・スキャンされる', async () => {
  await server.close();
  server = await startServer();
  base = server.base;

  // 固定ソースは起動を待たせず裏でスキャンされるので、完了まで追いかける
  let lib;
  for (let i = 0; i < 100; i++) {
    lib = await (await fetch(`${base}/api/library`)).json();
    const s = lib.sources.find((x) => x.dir === devDir);
    if (s && s.tracks > 0 && !lib.scanning) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const src = lib.sources.find((s) => s.dir === devDir);
  assert.ok(src, '固定ソースが起動時に復元されている');
  assert.equal(src.pinned, true);
  assert.equal(src.removable, true);
  assert.ok(lib.tracks.some((t) => t.title === 'SDの曲'), '復元されたソースの曲もスキャン済み');
});

test('取り外し: 固定ソースを外すと記録も消える', async () => {
  const lib = await (await fetch(`${base}/api/library`)).json();
  const src = lib.sources.find((s) => s.dir === devDir);
  const res = await fetch(`${base}/api/source/${src.id}`, { method: 'DELETE' });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(!json.sources.some((s) => s.dir === devDir));
  assert.deepEqual(await readConfig(), { pinned: [] });
});

test('サブフォルダ固定: デバイス配下のフォルダだけをソースにできる', async () => {
  const subDir = path.join(devDir, 'music');
  await mkdir(subDir, { recursive: true });
  await writeFile(path.join(subDir, 'inner.wav'),
    buildWav({ title: 'サブフォルダの曲', artist: 'C', album: 'Z' }));

  const { status, json } = await postJson(`${base}/api/source`, { path: subDir, pin: true });
  assert.equal(status, 200);
  const src = json.sources.find((s) => s.dir === subDir);
  assert.ok(src, 'サブフォルダがソースとして追加されている');
  assert.equal(src.label, 'music');
  assert.equal(src.pinned, true);
  assert.deepEqual(await readConfig(), { pinned: [subDir] });
  const lib = await waitForScan((l) => l.tracks.some((t) => t.title === 'サブフォルダの曲'));
  assert.ok(lib.tracks.some((t) => t.title === 'サブフォルダの曲'));

  // 後始末: 取り外して記録も消えることを確認
  const del = await fetch(`${base}/api/source/${src.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  assert.deepEqual(await readConfig(), { pinned: [] });
});

test('フォルダ参照: デバイス配下だけを辿れる', async () => {
  // 最上位はデバイス一覧
  const top = await (await fetch(`${base}/api/browse`)).json();
  assert.equal(top.path, null);
  assert.ok(top.dirs.some((d) => d.path === devDir && d.name === 'TEST-SD'));

  // デバイス直下: サブフォルダが見え、親は null (デバイスルートが上限)
  const root = await (await fetch(`${base}/api/browse?path=${encodeURIComponent(devDir)}`)).json();
  assert.equal(root.path, devDir);
  assert.equal(root.parent, null);
  assert.ok(root.dirs.some((d) => d.name === 'music'));

  // サブフォルダ: 親はデバイスルート
  const sub = await (await fetch(`${base}/api/browse?path=${encodeURIComponent(path.join(devDir, 'music'))}`)).json();
  assert.equal(sub.parent, devDir);

  // デバイス外は 400
  const bad = await fetch(`${base}/api/browse?path=${encodeURIComponent(libDir)}`);
  assert.equal(bad.status, 400);
});

test('設定 API: PUT でマージ保存され GET で返る', async () => {
  const put1 = await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ normalize: true }),
  });
  assert.equal(put1.status, 200);
  const put2 = await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ volume: 80 }),
  });
  assert.equal(put2.status, 200);
  const got = await (await fetch(`${base}/api/settings`)).json();
  assert.equal(got.normalize, true, 'マージで既存キーが残る');
  assert.equal(got.volume, 80);

  const bad = await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([1, 2]),
  });
  assert.equal(bad.status, 400);
});

test('サブフォルダ固定: デバイス外のパスと実在しないフォルダは 400', async () => {
  const outside = await postJson(`${base}/api/source`, { path: libDir, pin: true });
  assert.equal(outside.status, 400);
  const missing = await postJson(`${base}/api/source`, { path: path.join(devDir, 'no-such-dir'), pin: true });
  assert.equal(missing.status, 400);
});

test('ソース単体の再スキャン: 追加ファイルが反映される', async () => {
  // 固定ソースとして追加し直し、初回スキャンの完了を待つ
  const { status, json } = await postJson(`${base}/api/source`, { path: devDir, pin: true });
  assert.equal(status, 200);
  const src = json.sources.find((s) => s.dir === devDir);
  const scanned = await waitForScan((l) => l.sources.find((s) => s.dir === devDir)?.tracks > 0);
  const before = scanned.sources.find((s) => s.dir === devDir).tracks;

  await writeFile(path.join(devDir, 'new.wav'),
    buildWav({ title: 'あとから追加した曲', artist: 'D', album: 'W' }));
  const res = await fetch(`${base}/api/source/${src.id}/rescan`, { method: 'POST' });
  assert.equal(res.status, 200);
  const lib = await waitForScan((l) => l.sources.find((s) => s.dir === devDir)?.tracks === before + 1);
  assert.equal(lib.sources.find((s) => s.dir === devDir).tracks, before + 1);
  assert.ok(lib.tracks.some((t) => t.title === 'あとから追加した曲'));
  assert.equal(lib.sources.find((s) => s.dir === devDir).pinned, true, '再スキャンしても固定は維持');

  // 不明 ID は 404
  const bad = await fetch(`${base}/api/source/000000000000/rescan`, { method: 'POST' });
  assert.equal(bad.status, 404);
});
