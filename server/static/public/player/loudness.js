// トラック音量正規化のゲイン計算。
// ITU-R BS.1770-4 の K 特性ラウドネス (EBU R128 / ReplayGain 2.0 と同じ測定法) で
// 統合ラウドネス (LUFS) を測り、目標レベルへの純粋な線形ゲインを返す。
// コンプレッサやリミッタは使わない (音質無劣化)。クリップしないようピークで頭打ち。
//
// 測定手順 (BS.1770):
//   1. K 特性フィルタ (高域シェルフ + ハイパス) を各チャンネルに適用
//   2. 400ms ブロック (75% オーバーラップ) ごとの平均パワーを取る
//   3. 絶対ゲート (-70 LUFS) → 相対ゲート (平均 -10 LU) で無音・静寂部を除外
//   4. 残ったブロックの平均パワー → 統合ラウドネス

const TARGET_LUFS = -18;   // ReplayGain 2.0 と同じ目標 (iTunes は約 -16)
const ABS_GATE_LUFS = -70; // 絶対ゲート
const BLOCK_SEC = 0.4;     // ゲーティングブロック長
const STEP_SEC = 0.1;      // ブロックの刻み (75% オーバーラップ)
const PEAK_CEILING = 0.98; // クリップ防止の上限

/** BS.1770 の K 特性フィルタ係数 (任意サンプルレート対応) */
function kWeighting(fs) {
  // ステージ1: 高域シェルフ (頭部音響効果の近似)
  let f0 = 1681.974450955533;
  let G = 3.999843853973347;
  let Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / fs);
  const Vh = 10 ** (G / 20);
  const Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const shelf = {
    b0: (Vh + Vb * K / Q + K * K) / a0,
    b1: 2 * (K * K - Vh) / a0,
    b2: (Vh - Vb * K / Q + K * K) / a0,
    a1: 2 * (K * K - 1) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  // ステージ2: ハイパス (低域の除去)
  f0 = 38.13547087602444;
  Q = 0.5003270373238773;
  K = Math.tan(Math.PI * f0 / fs);
  a0 = 1 + K / Q + K * K;
  const hp = {
    b0: 1, b1: -2, b2: 1,
    a1: 2 * (K * K - 1) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  // ハイパスの b 係数も a0 で正規化する
  hp.b0 /= a0; hp.b1 /= a0; hp.b2 /= a0;
  return [shelf, hp];
}

// チャンネル重み (L/R/C = 1.0、サラウンド = 1.41。LFE は判別不能なので同扱い)
function channelWeight(ch) {
  return ch >= 3 ? 1.41 : 1.0;
}

/**
 * 逐次解析器: ストリーミング再生の窓デコードから少しずつ PCM を受け取り、
 * いつでも「ここまでの統合ラウドネス」からゲインを出せる。
 * 全体を一括で渡せば ReplayGain スキャナ相当の一発計測になる。
 */
export function createLoudnessAnalyzer(sampleRate) {
  const coeffs = kWeighting(sampleRate);
  const step = Math.max(1, Math.round(sampleRate * STEP_SEC));
  const blockSteps = Math.round(BLOCK_SEC / STEP_SEC); // 4

  /** @type {{s1: Float64Array, s2: Float64Array}[]} チャンネルごとのフィルタ状態 */
  let filters = [];
  let stepSum = 0;   // 現在の刻みの重み付き二乗和 (全チャンネル合算)
  let stepN = 0;     // 現在の刻みに入れたサンプル数
  const stepSums = []; // 完了した刻みの二乗和
  const blocks = [];   // 完了したブロックの平均パワー
  let peak = 0;

  function filterState() {
    return { z: new Float64Array(4) }; // biquad 2 段 × (z1, z2)
  }

  function push(channelData, length) {
    const nch = channelData.length;
    while (filters.length < nch) filters.push(filterState());
    const n = length ?? channelData[0].length;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let c = 0; c < nch; c++) {
        let x = channelData[c][i];
        const a = x < 0 ? -x : x;
        if (a > peak) peak = a;
        const z = filters[c].z;
        // K 特性 biquad 2 段 (transposed direct form II)
        for (let s = 0; s < 2; s++) {
          const co = coeffs[s];
          const y = co.b0 * x + z[s * 2];
          z[s * 2] = co.b1 * x - co.a1 * y + z[s * 2 + 1];
          z[s * 2 + 1] = co.b2 * x - co.a2 * y;
          x = y;
        }
        sum += channelWeight(c) * x * x;
      }
      stepSum += sum;
      if (++stepN === step) {
        stepSums.push(stepSum);
        stepSum = 0;
        stepN = 0;
        if (stepSums.length >= blockSteps) {
          const from = stepSums.length - blockSteps;
          let e = 0;
          for (let k = from; k < stepSums.length; k++) e += stepSums[k];
          blocks.push(e / (blockSteps * step));
        }
      }
    }
  }

  function integratedLufs() {
    if (blocks.length === 0) return null;
    const loud = (ms) => -0.691 + 10 * Math.log10(ms);
    // 絶対ゲート
    let passing = blocks.filter((ms) => loud(ms) > ABS_GATE_LUFS);
    if (passing.length === 0) return null;
    // 相対ゲート: 通過ブロック平均の -10 LU
    const mean1 = passing.reduce((a, b) => a + b, 0) / passing.length;
    const rel = loud(mean1) - 10;
    passing = passing.filter((ms) => loud(ms) > rel);
    if (passing.length === 0) return null;
    const mean2 = passing.reduce((a, b) => a + b, 0) / passing.length;
    return loud(mean2);
  }

  function gain({ targetDb = TARGET_LUFS } = {}) {
    const lufs = integratedLufs();
    if (lufs == null) return 1;
    let g = 10 ** ((targetDb - lufs) / 20);
    if (peak * g > PEAK_CEILING) g = PEAK_CEILING / peak; // クリップ防止
    return g;
  }

  return { push, integratedLufs, gain, get peak() { return peak; }, get blocks() { return blocks.length; } };
}

/**
 * 一括計測 (mp3/aac の全体デコード用)。
 * @param {Float32Array[]} channelData
 * @param {number} sampleRate
 * @returns {number} 線形ゲイン (1.0 = 変更なし)
 */
export function computeTrackGain(channelData, sampleRate, opts = {}) {
  if (!channelData?.length || !channelData[0]?.length) return 1;
  const analyzer = createLoudnessAnalyzer(sampleRate);
  analyzer.push(channelData);
  return analyzer.gain(opts);
}
