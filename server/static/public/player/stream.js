// ストリーミング再生用のウィンドウ読み出し器 (ブラウザ / Node 両対応)
//
// 「曲全体を非圧縮 PCM (約 100MB/5 分) に展開して保持する」代わりに、
// 再生位置の周辺だけを動的にデコードして返す。各形式とも独立デコード可能な
// 単位 (FLAC: フレーム / ALAC: パケット / WAV・AIFF: 生 PCM) を持つため、
// ビット精度は全体デコードと同一。
//
// 共通インターフェース:
//   reader.sampleRate / channels / totalSamples
//   await reader.readWindow(fromSample, maxSamples)
//     -> { channelData: Float32Array[], length }  ([fromSample, fromSample+length) を返す)
//   reader.destroy()

import { indexFlacFrames, buildFlacSlice } from './flac-frames.js';
import { demuxMp4 } from './demux-mp4.js';

// ---- WAV (RIFF PCM) ---------------------------------------------------------

function createWavReader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'RIFF') return null;
  let fmt = null;
  let data = null;
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
    const size = view.getUint32(pos + 4, true);
    if (id === 'fmt ' && size >= 16) {
      fmt = {
        format: view.getUint16(pos + 8, true),
        channels: view.getUint16(pos + 10, true),
        sampleRate: view.getUint32(pos + 12, true),
        bits: view.getUint16(pos + 22, true),
      };
    } else if (id === 'data') {
      data = { start: pos + 8, size: Math.min(size, bytes.length - (pos + 8)) };
    }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || !data || fmt.channels < 1) return null;
  const isFloat = fmt.format === 3;
  if (fmt.format !== 1 && !isFloat) return null; // PCM / float 以外は対象外
  const bytesPer = fmt.bits >> 3;
  if (![1, 2, 3, 4].includes(bytesPer)) return null;
  const frameBytes = bytesPer * fmt.channels;
  const totalSamples = Math.floor(data.size / frameBytes);

  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    totalSamples,
    async readWindow(fromSample, maxSamples) {
      const n = Math.max(0, Math.min(maxSamples, totalSamples - fromSample));
      const channelData = Array.from({ length: fmt.channels }, () => new Float32Array(n));
      let p = data.start + fromSample * frameBytes;
      for (let s = 0; s < n; s++) {
        for (let c = 0; c < fmt.channels; c++) {
          let v;
          if (isFloat) v = view.getFloat32(p, true);
          else if (bytesPer === 1) v = (bytes[p] - 128) / 128; // WAV の 8bit は符号なし
          else if (bytesPer === 2) v = view.getInt16(p, true) / 0x8000;
          else if (bytesPer === 3) {
            const raw = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16);
            v = ((raw << 8) >> 8) / 0x800000;
          } else v = view.getInt32(p, true) / 0x80000000;
          channelData[c][s] = v;
          p += bytesPer;
        }
      }
      return { channelData, length: n };
    },
    destroy() {},
  };
}

// ---- AIFF / AIFC ------------------------------------------------------------

function createAiffReader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'FORM') return null;
  const formType = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  if (formType !== 'AIFF' && formType !== 'AIFC') return null;

  let comm = null;
  let ssnd = null;
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
    const size = view.getUint32(pos + 4);
    const dataStart = pos + 8;
    if (id === 'COMM' && size >= 18) {
      const exp = view.getUint16(dataStart + 8) & 0x7fff;
      const mant = view.getUint32(dataStart + 10) * 2 ** 32 + view.getUint32(dataStart + 14);
      comm = {
        channels: view.getUint16(dataStart),
        numFrames: view.getUint32(dataStart + 2),
        bits: view.getUint16(dataStart + 6),
        sampleRate: exp === 0 && mant === 0 ? 0 : mant * 2 ** (exp - 16383 - 63),
        comp: formType === 'AIFC' && size >= 22
          ? String.fromCharCode(bytes[dataStart + 18], bytes[dataStart + 19], bytes[dataStart + 20], bytes[dataStart + 21])
          : 'NONE',
      };
    } else if (id === 'SSND' && size >= 8) {
      ssnd = { start: dataStart + 8 + view.getUint32(dataStart), end: Math.min(dataStart + size, bytes.length) };
    }
    pos = dataStart + size + (size % 2);
  }
  if (!comm || !ssnd || comm.channels < 1) return null;
  const comp = comm.comp;
  if (!['NONE', 'twos', 'sowt', 'fl32', 'FL32', 'fl64', 'in24', 'in32', 'raw '].includes(comp)) return null;
  const littleEndian = comp === 'sowt';
  const isF32 = comp === 'fl32' || comp === 'FL32';
  const isF64 = comp === 'fl64';
  const bytesPer = isF64 ? 8 : Math.ceil(comm.bits / 8);
  const frameBytes = bytesPer * comm.channels;
  const avail = Math.floor((ssnd.end - ssnd.start) / frameBytes);
  const totalSamples = Math.min(comm.numFrames || avail, avail);

  return {
    sampleRate: comm.sampleRate,
    channels: comm.channels,
    totalSamples,
    async readWindow(fromSample, maxSamples) {
      const n = Math.max(0, Math.min(maxSamples, totalSamples - fromSample));
      const channelData = Array.from({ length: comm.channels }, () => new Float32Array(n));
      let p = ssnd.start + fromSample * frameBytes;
      for (let s = 0; s < n; s++) {
        for (let c = 0; c < comm.channels; c++) {
          let v;
          if (isF32) v = view.getFloat32(p);
          else if (isF64) v = view.getFloat64(p);
          else if (bytesPer === 1) v = view.getInt8(p) / 0x80;
          else if (bytesPer === 2) v = view.getInt16(p, littleEndian) / 0x8000;
          else if (bytesPer === 3) {
            const raw = littleEndian
              ? bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16)
              : (bytes[p] << 16) | (bytes[p + 1] << 8) | bytes[p + 2];
            v = ((raw << 8) >> 8) / 0x800000;
          } else v = view.getInt32(p, littleEndian) / 0x80000000;
          channelData[c][s] = v;
          p += bytesPer;
        }
      }
      return { channelData, length: n };
    },
    destroy() {},
  };
}

// ---- ALAC (m4a) --------------------------------------------------------------

function createAlacReader(bytes, alacModule) {
  const demuxed = demuxMp4(bytes);
  if (demuxed?.codec !== 'alac' || !demuxed.cookie || demuxed.packets.length === 0) return null;
  const dec = alacModule.createDecoder(demuxed.cookie);
  const frameLength = dec.frameLength;
  const totalSamples = demuxed.totalSamples ?? demuxed.packets.length * frameLength;

  return {
    sampleRate: dec.sampleRate,
    channels: dec.channels,
    totalSamples,
    async readWindow(fromSample, maxSamples) {
      const n = Math.max(0, Math.min(maxSamples, totalSamples - fromSample));
      if (n === 0) return { channelData: [], length: 0 };
      const firstPkt = Math.floor(fromSample / frameLength);
      const lastPkt = Math.min(Math.floor((fromSample + n - 1) / frameLength), demuxed.packets.length - 1);
      const span = (lastPkt - firstPkt + 1) * frameLength;
      const tmp = Array.from({ length: dec.channels }, () => new Float32Array(span));
      let pos = 0;
      for (let i = firstPkt; i <= lastPkt; i++) {
        const pkt = demuxed.packets[i];
        pos += dec.decodeInto(bytes.subarray(pkt.offset, pkt.offset + pkt.size), tmp, pos);
      }
      const offset = fromSample - firstPkt * frameLength;
      const len = Math.min(n, Math.max(0, pos - offset));
      return { channelData: tmp.map((c) => c.subarray(offset, offset + len)), length: len };
    },
    destroy() { dec.destroy(); },
  };
}

// ---- FLAC ---------------------------------------------------------------------

function createFlacReader(bytes, decodeAudioData, ctxSampleRate) {
  const index = indexFlacFrames(bytes);
  if (!index || index.totalSamples === 0) return null;
  // デコードはネイティブ (decodeAudioData) に任せるため、リサンプルが
  // 起きない (コンテキストが音源レート) ことをサンプル位置計算の前提にする
  if (ctxSampleRate && ctxSampleRate !== index.sampleRate) return null;
  const frames = index.frames;

  function frameIndexFor(sample) {
    let lo = 0;
    let hi = frames.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (frames[mid].startSample <= sample) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  return {
    sampleRate: index.sampleRate,
    channels: index.channels,
    totalSamples: index.totalSamples,
    async readWindow(fromSample, maxSamples) {
      const n = Math.max(0, Math.min(maxSamples, index.totalSamples - fromSample));
      if (n === 0) return { channelData: [], length: 0 };
      const fromIdx = frameIndexFor(fromSample);
      const toIdx = frameIndexFor(fromSample + n - 1);
      const slice = buildFlacSlice(bytes, index, fromIdx, toIdx);
      const buffer = await decodeAudioData(slice.buffer);
      const offset = fromSample - frames[fromIdx].startSample;
      const len = Math.min(n, Math.max(0, buffer.length - offset));
      const channelData = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        channelData.push(buffer.getChannelData(c).subarray(offset, offset + len));
      }
      return { channelData, length: len };
    },
    destroy() {},
  };
}

/**
 * トラックに応じたストリーム読み出し器を作る。対象外・解析失敗は null
 * (呼び出し側は従来の全体デコードにフォールバックする)。
 * @param {{ext: string}} track
 * @param {Uint8Array} bytes ファイル全体
 * @param {{alacModule?: object, decodeAudioData?: Function, ctxSampleRate?: number}} deps
 */
export function createStreamReader(track, bytes, { alacModule, decodeAudioData, ctxSampleRate } = {}) {
  try {
    switch (track.ext) {
      case '.wav':
        return createWavReader(bytes);
      case '.aif':
      case '.aiff':
      case '.aifc':
        return createAiffReader(bytes);
      case '.m4a':
      case '.m4b':
        return alacModule ? createAlacReader(bytes, alacModule) : null;
      case '.flac':
        return decodeAudioData ? createFlacReader(bytes, decodeAudioData, ctxSampleRate) : null;
      default:
        return null; // mp3/aac はフレーム間依存があるため全体デコードのまま
    }
  } catch {
    return null;
  }
}
