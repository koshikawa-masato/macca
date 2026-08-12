// MP4/M4A デマルチプレクサ (ブラウザ / Node 両対応の純 JS・ES モジュール)
// lib/mp4.js はメタデータ用に moov の一部だけを読むが、こちらは再生用に
// サンプルテーブル (stsc/stsz/stco) を解決して ALAC パケット列を取り出す。

/** buf 内 [start, end) のボックスを列挙する */
function* boxes(view, start, end) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos);
    const type = String.fromCharCode(
      view.getUint8(pos + 4), view.getUint8(pos + 5),
      view.getUint8(pos + 6), view.getUint8(pos + 7));
    let hdr = 8;
    if (size === 1) {
      if (pos + 16 > end) return;
      size = Number(view.getBigUint64(pos + 8));
      hdr = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < hdr || pos + size > end) return;
    yield { type, pos, size, dataStart: pos + hdr, dataEnd: pos + size };
    pos += size;
  }
}

function findBox(view, start, end, type) {
  for (const b of boxes(view, start, end)) if (b.type === type) return b;
  return null;
}

function findPath(view, start, end, path) {
  let s = start, e = end;
  for (const type of path) {
    const b = findBox(view, s, e, type);
    if (!b) return null;
    s = b.dataStart + (type === 'meta' ? 4 : 0);
    e = b.dataEnd;
  }
  return { dataStart: s, dataEnd: e };
}

/** stsd の音声サンプルエントリを解析する */
function parseSampleEntry(view, entryStart, entryEnd) {
  const format = String.fromCharCode(
    view.getUint8(entryStart + 4), view.getUint8(entryStart + 5),
    view.getUint8(entryStart + 6), view.getUint8(entryStart + 7));
  // 8 reserved(6)+dataRefIdx(2) の後に SoundDescription
  const sd = entryStart + 16;
  const version = view.getUint16(sd);
  let channels = view.getUint16(sd + 8);
  let sampleSize = view.getUint16(sd + 10);
  let sampleRate = view.getUint32(sd + 16) / 65536; // 16.16 固定小数
  // 子ボックスの開始位置 (QuickTime sound description v0/v1/v2)
  let childStart = sd + 20;
  if (version === 1) childStart += 16;
  else if (version === 2) {
    sampleRate = view.getFloat64(sd + 20);
    channels = view.getUint32(sd + 28);
    childStart = sd + 56;
  }
  // ALAC マジッククッキー ('alac' 子ボックス、version/flags 4 バイトの後)
  let cookie = null;
  for (const b of boxes(view, childStart, entryEnd)) {
    if (b.type === 'alac' && b.dataEnd - b.dataStart > 4) {
      cookie = { start: b.dataStart + 4, end: b.dataEnd };
    }
  }
  return { format, channels, sampleSize, sampleRate, cookie };
}

/** ALAC マジッククッキー (ALACSpecificConfig) を解析する */
export function parseAlacCookie(view, start) {
  return {
    frameLength: view.getUint32(start),
    bitDepth: view.getUint8(start + 5),
    numChannels: view.getUint8(start + 9),
    maxFrameBytes: view.getUint32(start + 12),
    sampleRate: view.getUint32(start + 20),
  };
}

/**
 * m4a ファイルを解析して、音声トラックの情報とサンプル (パケット) 列を返す。
 * @param {Uint8Array} bytes ファイル全体
 * @returns {null | {
 *   codec: string, sampleRate: number, channels: number, bitDepth: number,
 *   cookie: Uint8Array|null, alac: object|null,
 *   packets: {offset: number, size: number}[], totalSamples: number|null,
 * }}
 */
export function demuxMp4(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const moov = findBox(view, 0, bytes.byteLength, 'moov');
  if (!moov) return null;

  // 音声トラック (alac / mp4a / flac) を探す
  for (const trak of boxes(view, moov.dataStart, moov.dataEnd)) {
    if (trak.type !== 'trak') continue;
    const stbl = findPath(view, trak.dataStart, trak.dataEnd,
      ['mdia', 'minf', 'stbl']);
    if (!stbl) continue;
    const stsd = findBox(view, stbl.dataStart, stbl.dataEnd, 'stsd');
    if (!stsd || stsd.dataEnd - stsd.dataStart < 16) continue;
    const entryStart = stsd.dataStart + 8;
    const entry = parseSampleEntry(view, entryStart, stsd.dataEnd);
    if (!['alac', 'mp4a', 'fLaC', 'flac'].includes(entry.format)) continue;

    // サンプルテーブル
    const stsz = findBox(view, stbl.dataStart, stbl.dataEnd, 'stsz');
    const stsc = findBox(view, stbl.dataStart, stbl.dataEnd, 'stsc');
    const stco = findBox(view, stbl.dataStart, stbl.dataEnd, 'stco') ??
      findBox(view, stbl.dataStart, stbl.dataEnd, 'co64');
    const stts = findBox(view, stbl.dataStart, stbl.dataEnd, 'stts');

    const packets = [];
    if (stsz && stsc && stco) {
      const uniformSize = view.getUint32(stsz.dataStart + 4);
      const sampleCount = view.getUint32(stsz.dataStart + 8);
      const sizeAt = (i) => uniformSize !== 0
        ? uniformSize : view.getUint32(stsz.dataStart + 12 + i * 4);

      const is64 = stco.type === 'co64';
      const chunkCount = view.getUint32(stco.dataStart + 4);
      const chunkOffset = (i) => is64
        ? Number(view.getBigUint64(stco.dataStart + 8 + i * 8))
        : view.getUint32(stco.dataStart + 8 + i * 4);

      // stsc: (firstChunk, samplesPerChunk, descIdx) のラン
      const stscCount = view.getUint32(stsc.dataStart + 4);
      const runs = [];
      for (let i = 0; i < stscCount; i++) {
        const p = stsc.dataStart + 8 + i * 12;
        runs.push([view.getUint32(p), view.getUint32(p + 4)]);
      }

      let sample = 0;
      for (let c = 0; c < chunkCount && sample < sampleCount; c++) {
        let perChunk = 1;
        for (const [first, n] of runs) {
          if (c + 1 >= first) perChunk = n;
          else break;
        }
        let off = chunkOffset(c);
        for (let s = 0; s < perChunk && sample < sampleCount; s++, sample++) {
          const size = sizeAt(sample);
          packets.push({ offset: off, size });
          off += size;
        }
      }
    }

    // stts から総サンプル (PCM フレーム) 数
    let totalSamples = null;
    if (stts) {
      const n = view.getUint32(stts.dataStart + 4);
      totalSamples = 0;
      for (let i = 0; i < n; i++) {
        const p = stts.dataStart + 8 + i * 8;
        totalSamples += view.getUint32(p) * view.getUint32(p + 4);
      }
    }

    let cookie = null;
    let alac = null;
    if (entry.cookie) {
      cookie = bytes.subarray(entry.cookie.start, entry.cookie.end);
      // 'frma'/'alac' ラッパ付きクッキーは中身の ALACSpecificConfig まで剥がす
      if (cookie.byteLength >= 48 &&
          String.fromCharCode(cookie[4], cookie[5], cookie[6], cookie[7]) === 'frma') {
        cookie = cookie.subarray(24);
      }
      if (cookie.byteLength >= 24) {
        alac = parseAlacCookie(
          new DataView(cookie.buffer, cookie.byteOffset, cookie.byteLength), 0);
      }
    }

    const codec = entry.format === 'alac' ? 'alac'
      : entry.format === 'mp4a' ? 'aac' : 'flac';
    return {
      codec,
      sampleRate: alac?.sampleRate || entry.sampleRate,
      channels: alac?.numChannels || entry.channels,
      bitDepth: alac?.bitDepth || entry.sampleSize,
      cookie, alac, packets, totalSamples,
    };
  }
  return null;
}
