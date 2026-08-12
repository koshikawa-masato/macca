// トラック音量正規化 (iTunes の「サウンドチェック」に相当) のゲイン計算。
// デコード済み PCM から RMS ベースのラウドネスを測り、目標レベルへの
// 線形ゲインを返す。クリップしないようピークで頭打ちにする。

const WINDOW_SEC = 0.5;      // RMS 窓長
const GATE_DB = -60;         // これより静かな窓は無視 (曲間の無音対策)
const MAX_BOOST_DB = 12;     // 静かな曲を持ち上げる上限

/**
 * @param {Float32Array[]} channelData
 * @param {number} sampleRate
 * @param {{targetDb?: number}} [opts] 目標ラウドネス (dBFS, 既定 -18)
 * @returns {number} 線形ゲイン (1.0 = 変更なし)
 */
export function computeTrackGain(channelData, sampleRate, { targetDb = -18 } = {}) {
  if (!channelData?.length || !channelData[0]?.length) return 1;
  const win = Math.max(1, Math.round(sampleRate * WINDOW_SEC));
  const frames = channelData[0].length;
  const gate = 10 ** (GATE_DB / 10); // パワー比較用

  const windows = [];
  let peak = 0;
  for (let start = 0; start < frames; start += win) {
    const end = Math.min(start + win, frames);
    let sum = 0;
    for (const ch of channelData) {
      for (let i = start; i < end; i++) {
        const v = ch[i];
        sum += v * v;
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
      }
    }
    const meanSq = sum / ((end - start) * channelData.length);
    if (meanSq > gate) windows.push(meanSq);
  }
  if (windows.length === 0) return 1;

  // 上位 5% 地点のパワー = 「聴感上の大きさ」の代表値
  windows.sort((a, b) => a - b);
  const p95 = windows[Math.min(windows.length - 1, Math.floor(windows.length * 0.95))];
  const loudnessDb = 10 * Math.log10(p95);

  let gainDb = Math.min(targetDb - loudnessDb, MAX_BOOST_DB);
  let gain = 10 ** (gainDb / 20);
  if (peak * gain > 0.99) gain = 0.99 / peak; // クリップ防止
  return gain;
}
