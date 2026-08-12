// ストリーミング再生用のウィンドウ読み出し器 (ブラウザ / Node 両対応)
//
// 「曲全体を非圧縮 PCM (約 100MB/5 分) に展開して保持する」代わりに、
// 再生位置の周辺だけを動的にデコードして返す。さらにファイル取得も
// プログレッシブ (受信しながら) に行い、必要な範囲が届いた時点で
// 再生を開始できる。各形式とも独立デコード可能な単位
// (FLAC: フレーム / ALAC: パケット / WAV・AIFF: 生 PCM) を持つため、
// ビット精度は全体デコードと同一。
//
// 共通インターフェース:
//   reader.sampleRate / channels / totalSamples
//   await reader.readWindow(fromSample, maxSamples)
//     -> { channelData: Float32Array[], length }  ([fromSample, fromSample+length) を返す)
//   reader.destroy()

import { parseFlacHeader, scanFlacFrames, buildFlacSlice } from './flac-frames.js';
import { demuxMp4 } from './demux-mp4.js';

// ---- プログレッシブ取得ソース ------------------------------------------------

/** 取得済みの Uint8Array をソース化する (テスト・フォールバック用) */
export function staticSource(bytes) {
  return {
    bytes,
    total: bytes.byteLength,
    get received() { return bytes.byteLength; },
    get done() { return true; },
    async waitFor() {},
    async waitAll() { return bytes; },
    cancel() {},
  };
}

/**
 * URL を受信しながら使えるソースにする。
 * bytes はファイル全長で確保済みで、received バイトまでが有効。
 */
export async function createProgressiveSource(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total) {
    return staticSource(new Uint8Array(await res.arrayBuffer()));
  }
  const bytes = new Uint8Array(total);
  const state = { received: 0, done: false, error: null, cancelled: false };
  const waiters = [];
  const notify = () => {
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (state.received >= waiters[i].need || state.done) {
        waiters.splice(i, 1)[0].resolve();
      }
    }
  };
  const readerP = res.body.getReader();
  (async () => {
    for (;;) {
      const { value, done } = await readerP.read();
      if (done || state.cancelled) break;
      const n = Math.min(value.length, total - state.received);
      if (n > 0) bytes.set(value.subarray(0, n), state.received);
      state.received += n;
      notify();
    }
  })().then(
    () => { state.done = true; notify(); },
    (err) => { state.error = err; state.done = true; notify(); },
  );

  return {
    bytes,
    total,
    get received() { return state.received; },
    get done() { return state.done; },
    /** end バイト目までの受信を待つ */
    async waitFor(end) {
      end = Math.min(end, total);
      while (state.received < end && !state.done) {
        await new Promise((resolve) => { waiters.push({ need: end, resolve }); });
      }
      if (state.error && state.received < end) throw state.error;
    },
    async waitAll() {
      await this.waitFor(total);
      return bytes;
    },
    cancel() {
      state.cancelled = true;
      readerP.cancel().catch(() => {});
    },
  };
}

function asSource(bytesOrSource) {
  return bytesOrSource instanceof Uint8Array ? staticSource(bytesOrSource) : bytesOrSource;
}

// ---- WAV (RIFF PCM) ---------------------------------------------------------

async function createWavReader(source) {
  const { bytes, total } = source;
  // チャンクヘッダを先頭から歩く (data はヘッダだけ読めばよい)
  await source.waitFor(Math.min(total, 12));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (total < 12 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'RIFF') return null;
  let fmt = null;
  let data = null;
  let pos = 12;
  while (pos + 8 <= total) {
    await source.waitFor(pos + 8);
    const id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
    const size = view.getUint32(pos + 4, true);
    if (id === 'fmt ' && size >= 16) {
      await source.waitFor(pos + 8 + 16);
      fmt = {
        format: view.getUint16(pos + 8, true),
        channels: view.getUint16(pos + 10, true),
        sampleRate: view.getUint32(pos + 12, true),
        bits: view.getUint16(pos + 22, true),
      };
    } else if (id === 'data') {
      data = { start: pos + 8, size: Math.min(size, total - (pos + 8)) };
      if (fmt) break; // fmt が先に来る通常配置なら data 本体は待たない
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
      const startByte = data.start + fromSample * frameBytes;
      await source.waitFor(startByte + n * frameBytes);
      const channelData = Array.from({ length: fmt.channels }, () => new Float32Array(n));
      let p = startByte;
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
    destroy() { source.cancel?.(); },
  };
}

// ---- AIFF / AIFC ------------------------------------------------------------

async function createAiffReader(source) {
  const { bytes, total } = source;
  await source.waitFor(Math.min(total, 12));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (total < 12 || String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'FORM') return null;
  const formType = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  if (formType !== 'AIFF' && formType !== 'AIFC') return null;

  let comm = null;
  let ssnd = null;
  let pos = 12;
  while (pos + 8 <= total) {
    await source.waitFor(pos + 8);
    const id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
    const size = view.getUint32(pos + 4);
    const dataStart = pos + 8;
    if (id === 'COMM' && size >= 18) {
      await source.waitFor(dataStart + Math.min(size, 22));
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
      if (ssnd) break;
    } else if (id === 'SSND' && size >= 8) {
      await source.waitFor(dataStart + 8);
      ssnd = { start: dataStart + 8 + view.getUint32(dataStart), end: Math.min(dataStart + size, total) };
      if (comm) break;
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
      const startByte = ssnd.start + fromSample * frameBytes;
      await source.waitFor(startByte + n * frameBytes);
      const channelData = Array.from({ length: comm.channels }, () => new Float32Array(n));
      let p = startByte;
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
    destroy() { source.cancel?.(); },
  };
}

// ---- ALAC (m4a) --------------------------------------------------------------

async function createAlacReader(source, alacModule) {
  const { bytes, total } = source;
  // トップレベルの box を歩いて moov の受信を待つ (moov が先頭なら数百 KB で済む)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  for (;;) {
    if (pos + 8 > total) return null;
    await source.waitFor(pos + 16);
    let size = view.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    if (size === 1) size = Number(view.getBigUint64(pos + 8));
    else if (size === 0) size = total - pos;
    if (size < 8) return null;
    if (type === 'moov') {
      await source.waitFor(pos + size);
      break;
    }
    pos += size;
  }
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
      const endPkt = demuxed.packets[lastPkt];
      await source.waitFor(endPkt.offset + endPkt.size);
      const span = (lastPkt - firstPkt + 1) * frameLength;
      const tmp = Array.from({ length: dec.channels }, () => new Float32Array(span));
      let pos2 = 0;
      for (let i = firstPkt; i <= lastPkt; i++) {
        const pkt = demuxed.packets[i];
        pos2 += dec.decodeInto(bytes.subarray(pkt.offset, pkt.offset + pkt.size), tmp, pos2);
      }
      const offset = fromSample - firstPkt * frameLength;
      const len = Math.min(n, Math.max(0, pos2 - offset));
      return { channelData: tmp.map((c) => c.subarray(offset, offset + len)), length: len };
    },
    destroy() {
      dec.destroy();
      source.cancel?.();
    },
  };
}

// ---- FLAC ---------------------------------------------------------------------

async function createFlacReader(source, decodeAudioData, ctxSampleRate) {
  const { bytes, total } = source;
  // メタデータ部 (STREAMINFO 〜 PICTURE 等) の受信を待ってヘッダを解析
  let need = Math.min(total, 64 * 1024);
  let header = null;
  for (;;) {
    await source.waitFor(need);
    header = parseFlacHeader(bytes.subarray(0, Math.min(source.received, total)));
    if (header || need >= total) break;
    need = Math.min(total, need * 4);
  }
  if (!header || header.totalSamples === 0) return null;
  // デコードはネイティブ (decodeAudioData) に任せるため、リサンプルが
  // 起きない (コンテキストが音源レート) ことをサンプル位置計算の前提にする
  if (ctxSampleRate && ctxSampleRate !== header.sampleRate) return null;

  // フレーム索引は受信に合わせて逐次拡張する
  const idx = { frames: [], scanPos: header.audioStart, expected: 0, complete: false };
  const SCAN_STEP = 512 * 1024;

  async function ensureIndexed(sample) {
    let guard = 0;
    while (!idx.complete && (idx.frames.length === 0 || idx.expected <= sample)) {
      if (++guard > 4096) throw new Error('FLAC索引が収束しません'); // 想定外でも無限ループにしない
      const target = Math.min(total, idx.scanPos + SCAN_STEP);
      await source.waitFor(target);
      const limit = source.done && source.received >= total ? total + 20 : source.received;
      const r = scanFlacFrames(bytes, header, idx.scanPos, idx.expected, limit);
      idx.frames.push(...r.frames);
      idx.expected = r.expected;
      if (r.scanPos >= total || idx.expected >= header.totalSamples) {
        idx.complete = true;
      } else if (r.scanPos === idx.scanPos && source.done) {
        idx.complete = true; // これ以上進めない
      }
      idx.scanPos = Math.max(r.scanPos, idx.scanPos);
      if (source.done && source.received >= total && r.scanPos >= total) idx.complete = true;
    }
  }

  function frameIndexFor(sample) {
    const frames = idx.frames;
    let lo = 0;
    let hi = frames.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (frames[mid].startSample <= sample) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  const index = {
    streamInfo: header.streamInfo,
    get frames() { return idx.frames; },
  };

  return {
    sampleRate: header.sampleRate,
    channels: header.channels,
    totalSamples: header.totalSamples,
    async readWindow(fromSample, maxSamples) {
      const n = Math.max(0, Math.min(maxSamples, header.totalSamples - fromSample));
      if (n === 0) return { channelData: [], length: 0 };
      // 必要範囲 + 次の 1 フレーム (終端オフセット確定のため) まで索引
      await ensureIndexed(fromSample + n);
      const frames = idx.frames;
      if (frames.length === 0) return { channelData: [], length: 0 };
      const fromIdx = frameIndexFor(fromSample);
      let toIdx = frameIndexFor(Math.min(fromSample + n - 1, idx.expected - 1));
      const end = toIdx + 1 < frames.length ? frames[toIdx + 1].offset : total;
      await source.waitFor(end);
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
    destroy() { source.cancel?.(); },
  };
}

/**
 * トラックに応じたストリーム読み出し器を作る。対象外・解析失敗は null
 * (呼び出し側は従来の全体デコードにフォールバックする)。
 * @param {{ext: string}} track
 * @param {Uint8Array | object} bytesOrSource ファイル全体 or プログレッシブソース
 * @param {{alacModule?: object, decodeAudioData?: Function, ctxSampleRate?: number}} deps
 */
export async function createStreamReader(track, bytesOrSource, { alacModule, decodeAudioData, ctxSampleRate } = {}) {
  const source = asSource(bytesOrSource);
  try {
    switch (track.ext) {
      case '.wav':
        return await createWavReader(source);
      case '.aif':
      case '.aiff':
      case '.aifc':
        return await createAiffReader(source);
      case '.m4a':
      case '.m4b':
        return alacModule ? await createAlacReader(source, alacModule) : null;
      case '.flac':
        return decodeAudioData ? await createFlacReader(source, decodeAudioData, ctxSampleRate) : null;
      default:
        return null; // mp3/aac はフレーム間依存があるため全体デコードのまま
    }
  } catch {
    return null;
  }
}