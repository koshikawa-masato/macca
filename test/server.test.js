import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFixtures, buildWav } from './fixtures.js';
import { startExternalServer } from './go-harness.js';
import { createServer, defaultLibraryCandidates } from '../server.js';

let dir;
let deviceDir;
let server;
let base;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'macca-srv-'));
  await writeFixtures(dir);
  // 擬似リムーバブルデバイス (deviceLister をスタブして注入する)
  deviceDir = await mkdtemp(path.join(tmpdir(), 'macca-usb-'));
  await mkdir(path.join(deviceDir, 'MUSIC'), { recursive: true });
  await writeFile(path.join(deviceDir, 'MUSIC', 'ポータブル曲.wav'),
    buildWav({ title: 'ポータブル曲', artist: 'DAP', album: 'SD' }));
  const external = await startExternalServer(dir, {
    devices: [{ path: deviceDir, label: 'TEST-USB' }],
  });
  if (external) {
    server = external;
    base = external.base;
  } else {
    server = await createServer(dir, {
      useCache: false,
      deviceLister: async () => [{ path: deviceDir, label: 'TEST-USB' }],
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  }
});

after(async () => {
  if (server) {
    if (process.env.MACCA_SERVER_BIN) await server.close();
    else await new Promise((resolve) => server.close(resolve));
  }
  await rm(dir, { recursive: true, force: true });
  await rm(deviceDir, { recursive: true, force: true });
});

test('GET / が index.html を返す', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.ok(html.includes('macca'), 'アプリのHTMLが返る');
});

test('GET /api/library がライブラリを返す', async () => {
  const res = await fetch(`${base}/api/library`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.tracks.length, 6);
  const t = json.tracks.find((x) => x.title === '流星ダンス');
  assert.ok(t);
  assert.equal(t.artist, '高野テスト');
  assert.equal(t.hasArt, true);
  assert.ok(!('art' in t), '内部の art オフセットはクライアントに出さない');
});

test('GET /api/stream/:id が Range リクエストに応える', async () => {
  const lib = await (await fetch(`${base}/api/library`)).json();
  const t = lib.tracks.find((x) => x.ext === '.mp3');
  const full = await fetch(`${base}/api/stream/${t.id}`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(Number(full.headers.get('content-length')), t.size);
  await full.arrayBuffer();

  const part = await fetch(`${base}/api/stream/${t.id}`, {
    headers: { Range: 'bytes=0-99' },
  });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 0-99/${t.size}`);
  const buf = Buffer.from(await part.arrayBuffer());
  assert.equal(buf.length, 100);
  assert.equal(buf.toString('ascii', 0, 3), 'ID3');
});

test('GET /api/artwork/:id が埋め込みアートを返す', async () => {
  const lib = await (await fetch(`${base}/api/library`)).json();
  for (const ext of ['.mp3', '.m4a', '.aiff', '.flac']) {
    const t = lib.tracks.find((x) => x.ext === ext && x.hasArt);
    assert.ok(t, `${ext} にアートあり`);
    const res = await fetch(`${base}/api/artwork/${t.id}`);
    assert.equal(res.status, 200, `${ext} のアート取得`);
    assert.equal(res.headers.get('content-type'), 'image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    // PNG マジックナンバー
    assert.equal(buf.readUInt32BE(0), 0x89504e47, `${ext} のアートが PNG`);
  }
});

test('GET /api/stats がメモリ・CPU情報を返す', async () => {
  await fetch(`${base}/api/stats`); // 1回目でCPU計測の基準を作る
  const res = await fetch(`${base}/api/stats`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(typeof json.rss === 'number' && json.rss > 0, 'rss はバイト数');
  assert.ok(typeof json.cpu === 'number', 'cpu は数値 (未対応環境は -1)');
});

test('存在しない ID は 404', async () => {
  const res = await fetch(`${base}/api/stream/deadbeefdeadbeef`);
  assert.equal(res.status, 404);
});

test('パストラバーサルは静的配信で拒否される', async () => {
  const res = await fetch(`${base}/..%2f..%2fserver.js`);
  assert.equal(res.status, 404);
});

test('デバイス: 検出 → スキャン → 統合 → 再生 → 取り外し', async () => {
  // 検出
  const dev = await (await fetch(`${base}/api/devices`)).json();
  assert.equal(dev.devices.length, 1);
  assert.equal(dev.devices[0].label, 'TEST-USB');
  assert.equal(dev.devices[0].scanned, false);

  // 任意パスのスキャンは拒否 (接続中デバイスのみ許可)
  const bad = await fetch(`${base}/api/source`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: path.dirname(deviceDir) }),
  });
  assert.equal(bad.status, 400);

  // スキャンしてライブラリに統合 (スキャンは裏で走るので完了を待つ)
  const res = await fetch(`${base}/api/source`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: deviceDir }),
  });
  assert.equal(res.status, 200);
  let lib = await res.json();
  assert.equal(lib.sources.length, 2);
  for (let i = 0; i < 100; i++) {
    if (!lib.scanning && lib.tracks.some((x) => x.title === 'ポータブル曲')) break;
    await new Promise((r) => setTimeout(r, 100));
    lib = await (await fetch(`${base}/api/library`)).json();
  }
  const t = lib.tracks.find((x) => x.title === 'ポータブル曲');
  assert.ok(t, 'デバイスの曲が統合されている');
  const devSrc = lib.sources.find((s) => s.removable);
  assert.equal(t.src, devSrc.id);

  // デバイス上のファイルをストリーミングできる
  const stream = await fetch(`${base}/api/stream/${t.id}`);
  assert.equal(stream.status, 200);
  await stream.arrayBuffer();

  // 取り外すとライブラリから消える (ファイルは残る)
  const del = await fetch(`${base}/api/source/${devSrc.id}`, { method: 'DELETE' });
  assert.equal(del.status, 200);
  const lib2 = await del.json();
  assert.equal(lib2.sources.length, 1);
  assert.ok(!lib2.tracks.some((x) => x.title === 'ポータブル曲'));

  // メインライブラリは取り外せない
  const main = lib2.sources[0];
  const delMain = await fetch(`${base}/api/source/${main.id}`, { method: 'DELETE' });
  assert.equal(delMain.status, 400);
});

test('defaultLibraryCandidates: iTunes / ミュージックの標準パスを優先順に返す', () => {
  const home = path.join(path.sep, 'home', 'x');
  const cands = defaultLibraryCandidates(home);
  const rel = cands.map((c) => path.relative(home, c).split(path.sep).join('/'));
  assert.equal(rel[0], 'Music/Music/Media.localized/Music', 'macOS ミュージック.app が最優先');
  assert.ok(rel.includes('Music/iTunes/iTunes Media/Music'), 'Windows / 旧 macOS の iTunes');
  assert.ok(rel.includes('Music/Apple Music/Media'), 'Windows 版 Apple Music');
  assert.equal(rel.at(-1), 'Music', '最後のフォールバックはミュージックフォルダ');
});
