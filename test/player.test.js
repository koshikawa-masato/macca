// ブラウザ側再生エンジンのデコーダ / プローブ / ラウドネス計算のテスト
// (public/player/ の ES モジュールは Node でもそのまま動く)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { probeSampleRate } from '../public/player/probe.js';
import { decodeAiff } from '../public/player/decode-aiff.js';
import { demuxMp4 } from '../public/player/demux-mp4.js';
import { loadAlac, decodeAlacTrack } from '../public/player/alac.js';
import { computeTrackGain } from '../public/player/loudness.js';
import { buildWav, buildFlac, buildMp3, buildAiff } from './fixtures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('probe: WAV / FLAC / MP3 / AIFF のサンプルレートを検出する', () => {
  const wav = new Uint8Array(buildWav({ title: 't', artist: 'a', album: 'x' }));
  assert.deepEqual(probeSampleRate(wav, '.wav'), { sampleRate: 8000, channels: 1 });

  const flac = new Uint8Array(buildFlac({ title: 't' }));
  assert.deepEqual(probeSampleRate(flac, '.flac'), { sampleRate: 44100, channels: 1 });

  // ID3v2 タグ付き MP3 (44.1kHz CBR フレーム)
  const mp3 = new Uint8Array(buildMp3({ title: 't', artist: 'a' }));
  assert.equal(probeSampleRate(mp3, '.mp3').sampleRate, 44100);

  const aiff = new Uint8Array(buildAiff({ title: 't' }));
  assert.deepEqual(probeSampleRate(aiff, '.aiff'), { sampleRate: 8000, channels: 1 });
});

test('decodeAiff: 16bit BE PCM を正確に展開する', () => {
  const bytes = new Uint8Array(buildAiff({ title: 't' }, null, 2));
  const pcm = decodeAiff(bytes);
  assert.equal(pcm.sampleRate, 8000);
  assert.equal(pcm.channels, 1);
  assert.equal(pcm.length, 16000);
  // fixtures.buildAiff は sin(i * 0.2) * 8000 を書き込む
  for (const i of [0, 1, 100, 8191, 15999]) {
    const expect = Math.round(Math.sin(i * 0.2) * 8000) / 0x8000;
    assert.ok(Math.abs(pcm.channelData[0][i] - expect) < 1e-6,
      `sample ${i}: ${pcm.channelData[0][i]} != ${expect}`);
  }
});

test('demuxMp4: ALAC の m4a からクッキーとパケット列を取り出す', async () => {
  const bytes = new Uint8Array(await readFile(path.join(__dirname, 'data/alac-sine.m4a')));
  const d = demuxMp4(bytes);
  assert.equal(d.codec, 'alac');
  assert.equal(d.sampleRate, 44100);
  assert.equal(d.channels, 2);
  assert.equal(d.bitDepth, 16);
  assert.equal(d.totalSamples, 44100);
  assert.ok(d.cookie.byteLength >= 24);
  assert.ok(d.packets.length > 0);
  for (const p of d.packets) {
    assert.ok(p.offset >= 0 && p.offset + p.size <= bytes.byteLength, 'パケットがファイル範囲内');
  }
});

test('ALAC: wasm デコーダが波形をロスレスに復元する', async () => {
  const bytes = new Uint8Array(await readFile(path.join(__dirname, 'data/alac-sine.m4a')));
  const wasm = await readFile(path.join(__dirname, '../public/player/alac.wasm'));
  const mod = await loadAlac(wasm);
  const d = demuxMp4(bytes);
  const pcm = decodeAlacTrack(d, bytes, mod);

  assert.equal(pcm.sampleRate, 44100);
  assert.equal(pcm.channels, 2);
  assert.equal(pcm.length, 44100);

  // 元データは 440Hz 振幅 16000 のサイン波 (test/data/alac-sine.m4a 生成条件)
  const amp = 16000 / 32768;
  let maxErr = 0;
  for (let i = 0; i < 44100; i += 7) {
    const expect = Math.round(Math.sin(2 * Math.PI * 440 * i / 44100) * 16000) / 32768;
    maxErr = Math.max(maxErr, Math.abs(pcm.channelData[0][i] - expect));
    assert.ok(Math.abs(pcm.channelData[1][i] - pcm.channelData[0][i]) < 1e-6, 'L/R 同一');
  }
  assert.ok(maxErr < 1e-4, `ロスレス復元 (maxErr=${maxErr})`);
});

test('loudness: RMS ベースの正規化ゲインを計算する', () => {
  const rate = 44100;
  const loud = new Float32Array(rate * 2);
  for (let i = 0; i < loud.length; i++) loud[i] = Math.sin(2 * Math.PI * 440 * i / rate) * 0.5;
  // 振幅 0.5 のサイン波: パワー = 0.125 (-9dB) → 目標 -18dB へ約 -9dB (×0.35)
  const g1 = computeTrackGain([loud], rate);
  assert.ok(g1 > 0.3 && g1 < 0.4, `大音量は下げる (gain=${g1})`);

  const quiet = new Float32Array(rate * 2);
  for (let i = 0; i < quiet.length; i++) quiet[i] = Math.sin(2 * Math.PI * 440 * i / rate) * 0.01;
  // -43dB → +12dB 上限でブースト (×3.98)
  const g2 = computeTrackGain([quiet], rate);
  assert.ok(g2 > 3.5 && g2 < 4.2, `小音量は上限まで上げる (gain=${g2})`);

  // クリップ防止: ほぼフルスケールの静かな曲もどきはピークで頭打ち
  const spiky = new Float32Array(rate);
  spiky[100] = 0.98;
  const g3 = computeTrackGain([spiky], rate);
  assert.ok(spiky[100] * g3 <= 0.99 + 1e-6, `ピーククリップ防止 (gain=${g3})`);

  assert.equal(computeTrackGain([new Float32Array(rate)], rate), 1, '無音は等倍');
});
