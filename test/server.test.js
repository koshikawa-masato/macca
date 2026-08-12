import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFixtures } from './fixtures.js';
import { createServer, defaultLibraryCandidates } from '../server.js';

let dir;
let server;
let base;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'macca-srv-'));
  await writeFixtures(dir);
  server = await createServer(dir, { useCache: false });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
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

test('存在しない ID は 404', async () => {
  const res = await fetch(`${base}/api/stream/deadbeefdeadbeef`);
  assert.equal(res.status, 404);
});

test('パストラバーサルは静的配信で拒否される', async () => {
  const res = await fetch(`${base}/..%2f..%2fserver.js`);
  assert.equal(res.status, 404);
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
