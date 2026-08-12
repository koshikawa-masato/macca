// MP3 の再生時間推定
// Xing/Info ヘッダ (VBR) があればフレーム数から正確に、なければ CBR とみなして推定する。

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES = {
  3: [44100, 48000, 32000], // MPEG1
  2: [22050, 24000, 16000], // MPEG2
  0: [11025, 12000, 8000],  // MPEG2.5
};

/**
 * @param {Buffer} buf ID3 タグ直後から始まる先頭数十 KB のバッファ
 * @param {number} audioBytes ファイルサイズからタグ分を引いた概算オーディオバイト数
 * @returns {number|null} 秒数
 */
export function estimateMp3Duration(buf, audioBytes) {
  // 最初のフレーム同期を探す
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) continue;
    const version = (buf[i + 1] >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
    const layer = (buf[i + 1] >> 1) & 0x03;   // 1=Layer3
    const bitrateIdx = (buf[i + 2] >> 4) & 0x0f;
    const srIdx = (buf[i + 2] >> 2) & 0x03;
    if (version === 1 || layer !== 1 || bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3) continue;

    const sampleRate = SAMPLE_RATES[version]?.[srIdx];
    if (!sampleRate) continue;
    const bitrate = (version === 3 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bitrateIdx] * 1000;
    const samplesPerFrame = version === 3 ? 1152 : 576;

    // Xing/Info ヘッダ (サイド情報の直後に置かれる)
    const channelMode = (buf[i + 3] >> 6) & 0x03;
    const sideInfo = version === 3
      ? (channelMode === 3 ? 17 : 32)
      : (channelMode === 3 ? 9 : 17);
    const xingPos = i + 4 + sideInfo;
    if (xingPos + 8 <= buf.length) {
      const tag = buf.toString('ascii', xingPos, xingPos + 4);
      if (tag === 'Xing' || tag === 'Info') {
        const flags = buf.readUInt32BE(xingPos + 4);
        if ((flags & 0x01) && xingPos + 12 <= buf.length) {
          const frames = buf.readUInt32BE(xingPos + 8);
          return (frames * samplesPerFrame) / sampleRate;
        }
      }
    }
    // CBR とみなす
    return bitrate > 0 ? (audioBytes * 8) / bitrate : null;
  }
  return null;
}
