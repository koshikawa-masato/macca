// ブラウザ側再生エンジンのデコーダ / プローブ / ラウドネス計算のテスト
// (public/player/ の ES モジュールは Node でもそのまま動く)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { probeSampleRate } from '../server/static/public/player/probe.js';
import { decodeAiff } from '../server/static/public/player/decode-aiff.js';
import { demuxMp4 } from '../server/static/public/player/demux-mp4.js';
import { loadAlac, decodeAlacTrack } from '../server/static/public/player/alac.js';
import { computeTrackGain } from '../server/static/public/player/loudness.js';
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
  const wasm = await readFile(path.join(__dirname, '../server/static/public/player/alac.wasm'));
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

test('loudness: BS.1770 (K 特性 + ゲート) の正規化ゲインを計算する', async () => {
  const { createLoudnessAnalyzer } = await import('../server/static/public/player/loudness.js');
  const rate = 44100;
  const sine = (amp, sec) => {
    const a = new Float32Array(Math.round(rate * sec));
    for (let i = 0; i < a.length; i++) a[i] = Math.sin(2 * Math.PI * 997 * i / rate) * amp;
    return a;
  };

  // 振幅 0.5 の 997Hz サイン波: K 特性込みで LUFS ≈ -9.1 → 目標 -18 へ約 ×0.358
  const g1 = computeTrackGain([sine(0.5, 2)], rate);
  assert.ok(g1 > 0.34 && g1 < 0.38, `大音量は下げる (gain=${g1})`);

  // 振幅 0.01: LUFS ≈ -43.1 → 約 ×17.9 (クリップしない範囲なら上限なし = ReplayGain 同等)
  const g2 = computeTrackGain([sine(0.01, 2)], rate);
  assert.ok(g2 > 16.5 && g2 < 19.5, `小音量はクリップしない範囲で目標まで上げる (gain=${g2})`);

  // ゲーティング: 長い無音は平均に入れない (無音混じりでも同じゲインになる)
  const withSilence = new Float32Array(rate * 6);
  withSilence.set(sine(0.5, 2), 0); // 残り 4 秒は無音
  const g3 = computeTrackGain([withSilence], rate);
  assert.ok(Math.abs(g3 - g1) < 0.02, `無音はゲートで除外 (gain=${g3} vs ${g1})`);

  // 逐次解析 (ストリーミングの窓ごと push) と一括計測が一致する
  const whole = sine(0.5, 3);
  const inc = createLoudnessAnalyzer(rate);
  for (let p = 0; p < whole.length; p += 4096) {
    const chunk = whole.subarray(p, Math.min(p + 4096, whole.length));
    inc.push([chunk], chunk.length);
  }
  const once = createLoudnessAnalyzer(rate);
  once.push([whole]);
  assert.ok(Math.abs(inc.integratedLufs() - once.integratedLufs()) < 1e-6,
    '逐次解析 = 一括計測');

  // クリップ防止: ピーク × ゲインが 1.0 を超えない
  const spiky = sine(0.02, 2);
  spiky[100] = 0.98;
  const g4 = computeTrackGain([spiky], rate);
  assert.ok(0.98 * g4 <= 0.99, `ピーククリップ防止 (gain=${g4})`);

  assert.equal(computeTrackGain([new Float32Array(rate)], rate), 1, '無音は等倍');
});
