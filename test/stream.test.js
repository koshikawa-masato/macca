// ストリーミング再生の窓読みリーダーの検証。
// 「任意位置の窓読み」が全体デコードとビット単位で一致することを確かめる。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { indexFlacFrames, buildFlacSlice } from '../server/static/public/player/flac-frames.js';
import { createStreamReader } from '../server/static/public/player/stream.js';
import { loadAlac, decodeAlacTrack } from '../server/static/public/player/alac.js';
import { demuxMp4 } from '../server/static/public/player/demux-mp4.js';
import { decodeAiff } from '../server/static/public/player/decode-aiff.js';
import { buildWav, buildAiff } from './fixtures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('FLAC索引: フレーム境界が連鎖し全サンプルを覆う', async () => {
  const bytes = new Uint8Array(await readFile(path.join(__dirname, 'data/flac-sine.flac')));
  const idx = indexFlacFrames(bytes);
  assert.ok(idx, '索引が作れる');
  assert.equal(idx.sampleRate, 44100);
  assert.equal(idx.channels, 2);
  assert.ok(idx.frames.length > 1);
  // 連鎖検証: 各フレームが前のフレームの直後から始まる
  for (let i = 1; i < idx.frames.length; i++) {
    assert.equal(idx.frames[i].startSample,
      idx.frames[i - 1].startSample + idx.frames[i - 1].blockSize, `frame ${i} 連鎖`);
  }
  const last = idx.frames.at(-1);
  assert.equal(last.startSample + last.blockSize, idx.totalSamples, '全サンプルを覆う');

  // スライスは fLaC マジックで始まり STREAMINFO を含む
  const slice = buildFlacSlice(bytes, idx, 1, 2);
  assert.equal(String.fromCharCode(...slice.subarray(0, 4)), 'fLaC');
  assert.equal(slice[4], 0x80, 'STREAMINFO が最終メタデータブロック');
});

test('ALACリーダー: 窓読みが全体デコードと一致する', async () => {
  const bytes = new Uint8Array(await readFile(path.join(__dirname, 'data/alac-sine.m4a')));
  const mod = await loadAlac(await readFile(path.join(__dirname, '../server/static/public/player/alac.wasm')));
  const full = decodeAlacTrack(demuxMp4(bytes), bytes, await loadAlac(
    await readFile(path.join(__dirname, '../server/static/public/player/alac.wasm'))));

  const r = await createStreamReader({ ext: '.m4a' }, bytes, { alacModule: mod });
  assert.ok(r);
  assert.equal(r.totalSamples, full.length);
  // パケット境界をまたぐ中途半端な位置から読む
  for (const [from, n] of [[0, 1000], [4000, 5000], [43000, 2000]]) {
    const w = await r.readWindow(from, n);
    assert.equal(w.length, Math.min(n, full.length - from), `[${from},+${n})の長さ`);
    for (let i = 0; i < w.length; i += 97) {
      assert.equal(w.channelData[0][i], full.channelData[0][from + i], `sample ${from + i}`);
    }
  }
  r.destroy();
});

test('WAVリーダー: 窓読みが波形と一致する', async () => {
  const bytes = new Uint8Array(buildWav({ title: 't', artist: 'a', album: 'x', seconds: 2 }));
  const r = await createStreamReader({ ext: '.wav' }, bytes, {});
  assert.ok(r);
  assert.equal(r.sampleRate, 8000);
  assert.equal(r.totalSamples, 16000);
  const w = await r.readWindow(5000, 3000);
  assert.equal(w.length, 3000);
  for (let i = 0; i < 3000; i += 41) {
    const expect = Math.round(Math.sin((5000 + i) * 0.2) * 8000) / 0x8000;
    assert.ok(Math.abs(w.channelData[0][i] - expect) < 1e-6, `sample ${5000 + i}`);
  }
});

test('AIFFリーダー: 窓読みが全体デコードと一致する', async () => {
  const bytes = new Uint8Array(buildAiff({ title: 't' }, null, 2));
  const full = decodeAiff(bytes);
  const r = await createStreamReader({ ext: '.aiff' }, bytes, {});
  assert.ok(r);
  assert.equal(r.totalSamples, full.length);
  const w = await r.readWindow(7000, 4000);
  assert.equal(w.length, 4000);
  for (let i = 0; i < 4000; i += 37) {
    assert.equal(w.channelData[0][i], full.channelData[0][7000 + i], `sample ${7000 + i}`);
  }
});

test('リーダー対象外の形式は null (全体デコードへフォールバック)', async () => {
  assert.equal(await createStreamReader({ ext: '.mp3' }, new Uint8Array(64), {}), null);
  assert.equal(await createStreamReader({ ext: '.wav' }, new Uint8Array(8), {}), null, '壊れたWAV');
});
