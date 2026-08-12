// Web Audio ベースの再生エンジン
//
// <audio> タグとの違い:
//  - ギャップレス再生: 次曲を先読みデコードし、現曲の終端にサンプル精度で連結
//  - リサンプリング回避: AudioContext を音源のサンプルレートに合わせて生成
//  - 音量正規化: デコード済み PCM から実測したゲインで曲間の音量差を揃える
//  - ALAC / AIFF を同梱デコーダ (alac.wasm / 純 JS) でブラウザ内デコード
//    (サーバ側 ffmpeg 不要、シークも可能)

import { demuxMp4 } from './demux-mp4.js';
import { decodeAiff } from './decode-aiff.js';
import { probeSampleRate } from './probe.js';
import { computeTrackGain } from './loudness.js';
import { loadAlac, decodeAlacTrack } from './alac.js';
import { createStreamReader, createProgressiveSource } from './stream.js';

const ENGINE_EXTS = new Set([
  '.mp3', '.aac', '.m4a', '.m4b', '.flac', '.wav', '.aif', '.aiff', '.aifc',
]);
const GAIN_CACHE_KEY = 'macca-track-gains';
const GAIN_CACHE_MAX = 5000;

// ストリーミング再生: 一度にデコードする窓と先行デコード量 (秒)。
// FLAC/ALAC/WAV/AIFF はこの窓単位で動的にデコードし、再生済み分は解放する
const STREAM_WINDOW_SEC = 15;
const STREAM_AHEAD_SEC = 30;

// これより長いトラックは全体デコードせず <audio> ストリーミングに任せる
// (全体デコードは開始が遅くメモリも食う: 44.1kHz ステレオで約 21MB/分)
const MAX_ENGINE_DURATION = 15 * 60;

export class AudioEngine {
  constructor({ wasmUrl = '/player/alac.wasm', streamUrl = (t) => `/api/stream/${t.id}` } = {}) {
    this.wasmUrl = wasmUrl;
    this.streamUrl = streamUrl;
    this.ctx = null;
    this.masterGain = null;
    this.volume = 1;
    this.normalization = false;

    /** @type {null | {track, buffer, gainNode, source, startTime, trackGain}} */
    this.current = null;
    /** @type {null | {track, promise, entry, source}} entry = {buffer, trackGain} */
    this.next = null;

    this.nextProvider = null;        // () => track | null
    this.ontrackstart = null;        // (track, {auto}) => void
    this.onqueueend = null;          // () => void
    this.onhandoff = null;           // (track) => void  エンジン非対応の次曲を委譲

    this._gen = 0;
    this._alacPromise = null;
    this._gains = null;
    this._gainsSaveTimer = null;
    this._bufferCache = new Map(); // trackId -> {buffer, trackGain} 直近のデコード結果
  }

  /**
   * デコード済みバッファのキャッシュ (1 エントリのみ)。
   * 直近にデコードした曲 = ほぼ常に再生中の曲への参照なので追加メモリはゼロで、
   * 同じ曲の再クリックやリピートを即時にする。
   */
  _cachePut(id, buffer, trackGain) {
    this._bufferCache.clear();
    this._bufferCache.set(id, { buffer, trackGain });
  }

  /** このエンジンでデコード・再生できる形式・長さか */
  canPlay(track) {
    if (typeof AudioContext === 'undefined' || !ENGINE_EXTS.has(track.ext)) return false;
    if (track.duration && track.duration > MAX_ENGINE_DURATION) return false; // 長尺は <audio> へ
    return true;
  }

  get playingTrack() { return this.current?.track ?? null; }
  get paused() { return this.ctx ? this.ctx.state !== 'running' : true; }
  get duration() { return this.current?.duration ?? 0; }

  get currentTime() {
    if (!this.current || !this.ctx) return 0;
    const t = this.ctx.currentTime - this.current.startTime;
    return Math.min(Math.max(t, 0), this.current.duration);
  }

  /**
   * ユーザー操作 (クリック等) の同期文脈で AudioContext を起こす。
   * 非同期処理の後で resume するとブラウザのジェスチャー判定が切れて
   * 拒否されることがあるため、クリック直後に必ず呼ぶ。
   */
  kickContext() {
    this._userPaused = false;
    if (this.ctx && this.ctx.state !== 'running') this.ctx.resume().catch(() => {});
  }

  /** トラックを (ユーザー操作起点で) 再生する */
  async play(track) {
    this.kickContext();
    const gen = ++this._gen;
    // 「次の曲へ」で選ばれた曲なら、先読み済みの取得/デコード結果を使い回す
    const reuse = this.next && this.next.track === track && !this.next.handoff ? this.next : null;
    if (reuse) {
      this._unscheduleNext();
      this.next = null; // teardown でリーダーを破棄されないよう切り離す
    }
    this._teardownPlayback();

    let decoded = null;
    if (reuse) {
      const entry = reuse.entry ?? await this._ensureNextDecoded(reuse, gen);
      if (gen !== this._gen) return;
      if (entry && !entry.error) {
        decoded = entry; // buffer / reader どちらの形態もそのまま使う
      }
    }
    if (!decoded) {
      decoded = await this._decode(track, { forPlayback: true });
    }
    if (gen !== this._gen) return; // 待っている間に別の再生が始まった

    await this._ensureContext(decoded.reader?.sampleRate ?? decoded.buffer.sampleRate);
    if (gen !== this._gen) return;
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});

    this._startCurrent(track, decoded, 0, this.ctx.currentTime);
    this.ontrackstart?.(track, { auto: false });
    this._prefetchNext(gen);
    this._schedulePrefetch(gen);
  }

  pause() {
    this._userPaused = true;
    this.ctx?.suspend().catch(() => {});
  }

  resume() {
    this._userPaused = false;
    this.ctx?.resume().catch(() => {});
  }

  toggle() { this.paused ? this.resume() : this.pause(); }

  seek(seconds) {
    if (!this.current || !this.ctx) return;
    // シークは「ここから聴きたい」という操作なので、一時停止中や
    // OS にコンテキストを止められた状態からでも必ず音が出るよう復帰させる
    this.kickContext();
    const cur = this.current;
    const offset = Math.min(Math.max(seconds, 0), cur.duration - 0.05);
    const now = this.ctx.currentTime;
    this._unscheduleNext();

    if (cur.kind === 'stream') {
      // スケジュール済みセグメントを破棄し、シーク位置から窓読みをやり直す
      for (const seg of cur.segments) this._cancelSource(seg.source);
      cur.segments = [];
      clearTimeout(cur.pumpTimer);
      cur.epoch++;
      cur.startTime = now - offset;
      cur.nextSample = Math.floor(offset * cur.reader.sampleRate);
      this._pumpStream(this._gen);
    } else {
      this._cancelSource(cur.source);
      cur.source = this._makeSource(cur.buffer, cur.gainNode);
      cur.source.onended = this._makeEndedHandler(cur.source, this._gen);
      cur.source.start(now, offset);
      cur.startTime = now - offset;
    }
    // 新しい位置に合わせて次曲の連結とデコードタイマーを組み直す
    this._scheduleNextIfReady();
    this._schedulePrefetch(this._gen);
  }

  stop() {
    this._gen++;
    this._teardownPlayback();
  }

  setVolume(v) {
    this.volume = v;
    if (this.masterGain) this.masterGain.gain.value = v;
  }

  setNormalization(on) {
    this.normalization = on;
    for (const slot of [this.current, this.next?.entry]) {
      if (slot?.gainNode) slot.gainNode.gain.value = on && slot.trackGain != null ? slot.trackGain : 1;
    }
  }

  /** 再生モード変更などで、先読み済みの次曲を破棄して取り直す */
  refreshNext() {
    if (!this.current) return;
    this._unscheduleNext();
    this._dropNext();
    this._prefetchNext(this._gen);
    this._schedulePrefetch(this._gen);
  }

  // ---- 内部: コンテキスト管理 ----------------------------------------------

  async _ensureContext(sampleRate) {
    if (this.ctx && this.ctx.state !== 'closed' &&
        (!sampleRate || this.ctx.sampleRate === sampleRate)) return;
    const old = this.ctx;
    this.ctx = null;
    if (old) await old.close().catch(() => {});
    let ctx = null;
    if (sampleRate >= 8000 && sampleRate <= 192000) {
      try {
        ctx = new AudioContext({ sampleRate, latencyHint: 'playback' });
      } catch { /* このレートに未対応: 既定レートで作る */ }
    }
    this.ctx = ctx ?? new AudioContext({ latencyHint: 'playback' });
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = this.volume;
    this.masterGain.connect(this.ctx.destination);

    // OS の割り込み (スリープ・出力デバイス切替等) で勝手に suspended に
    // なったら復帰を試みる。ユーザーが明示的に一時停止した場合は何もしない
    this.ctx.onstatechange = () => {
      if (!this.ctx) return;
      if ((this.ctx.state === 'suspended' || this.ctx.state === 'interrupted') &&
          this.current && !this._userPaused) {
        this.ctx.resume().catch(() => {});
      }
    };
  }

  // ---- 内部: デコード -------------------------------------------------------

  async _alacModule() {
    this._alacPromise ??= (async () => {
      const res = await fetch(this.wasmUrl);
      if (!res.ok) throw new Error('alac.wasm が読み込めません');
      return loadAlac(await res.arrayBuffer());
    })();
    return this._alacPromise;
  }

  /**
   * トラックをデコードして {buffer|reader, trackGain} を返す。
   * forPlayback 時のみ AudioContext を音源レートで作り直してよい。
   */
  async _decode(track, { forPlayback = false } = {}) {
    const cached = this._bufferCache.get(track.id);
    if (cached) {
      if (forPlayback) await this._ensureContext(cached.buffer.sampleRate);
      // gainNode/source は呼び出し側が書き足すため、新しいオブジェクトで返す
      return { buffer: cached.buffer, trackGain: cached.trackGain };
    }
    const source = await createProgressiveSource(this.streamUrl(track));
    return this._decodeBytes(track, source, { forPlayback });
  }

  /**
   * ストリーミング可能な形式なら窓読みリーダーを作る (全体を待たない)。
   * 対象外・解析失敗・レート不一致は null → 全体デコードにフォールバック。
   */
  async _tryCreateReader(track, source, forPlayback) {
    const ext = track.ext;
    if (!['.flac', '.m4a', '.m4b', '.wav', '.aif', '.aiff', '.aifc'].includes(ext)) return null;
    let alacModule = null;
    let decodeFn = null;
    let ctxSampleRate = 0;
    if (ext === '.m4a' || ext === '.m4b') {
      alacModule = await this._alacModule(); // AAC だった場合はリーダー側が null を返す
    } else if (ext === '.flac') {
      // FLAC はネイティブデコーダに窓を渡すため、コンテキストが音源レートであることが前提
      await source.waitFor(Math.min(source.total, 64 * 1024));
      const rate = probeSampleRate(source.bytes.subarray(0, source.received), ext)?.sampleRate;
      if (!rate) return null;
      if (forPlayback) await this._ensureContext(rate);
      else if (!this.ctx) await this._ensureContext(rate);
      if (this.ctx.sampleRate !== rate) return null;
      ctxSampleRate = this.ctx.sampleRate;
      decodeFn = (ab) => this.ctx.decodeAudioData(ab);
    }
    return createStreamReader(track, source, { alacModule, decodeAudioData: decodeFn, ctxSampleRate });
  }

  /** 正規化ゲイン: キャッシュがあればそれを、なければ null (最初の窓から実測する) */
  _gainCached(track) {
    const g = this._loadGains()[track.id];
    return typeof g === 'number' ? g : null;
  }

  /** デコード済みの窓からゲインを実測してキャッシュする */
  _gainFromWindow(track, channelData, sampleRate) {
    const g = Math.round(computeTrackGain(channelData, sampleRate) * 1000) / 1000;
    this._loadGains()[track.id] = g;
    this._scheduleGainsSave();
    return g;
  }

  /** 取得中ソース (またはバイト列) からデコードする */
  async _decodeBytes(track, source, { forPlayback = false } = {}) {
    const reader = await this._tryCreateReader(track, source, forPlayback);
    if (reader) {
      return { reader, trackGain: this._gainCached(track) };
    }
    // 全体デコードへフォールバック (受信完了を待つ)
    const bytes = await source.waitAll();
    const ext = track.ext;
    let buffer;

    if (ext === '.m4a' || ext === '.m4b') {
      const demuxed = demuxMp4(bytes);
      if (demuxed?.codec === 'alac' && demuxed.cookie) {
        const pcm = decodeAlacTrack(demuxed, bytes, await this._alacModule());
        buffer = pcmToAudioBuffer(pcm);
      } else {
        buffer = await this._nativeDecode(bytes, demuxed?.sampleRate, forPlayback);
      }
    } else if (ext === '.aif' || ext === '.aiff' || ext === '.aifc') {
      buffer = pcmToAudioBuffer(decodeAiff(bytes));
    } else {
      buffer = await this._nativeDecode(bytes, probeSampleRate(bytes, ext)?.sampleRate, forPlayback);
    }

    const trackGain = this._gainFor(track, buffer);
    this._cachePut(track.id, buffer, trackGain);
    return { buffer, trackGain };
  }

  /** ブラウザ内蔵デコーダ (decodeAudioData) を使う */
  async _nativeDecode(bytes, sampleRate, forPlayback) {
    if (forPlayback && sampleRate) await this._ensureContext(sampleRate);
    else if (!this.ctx) await this._ensureContext(sampleRate || 0);
    // decodeAudioData は ArrayBuffer を detach するため所有権ごと渡す
    const ab = bytes.buffer.byteLength === bytes.byteLength
      ? bytes.buffer : bytes.slice().buffer;
    return this.ctx.decodeAudioData(ab);
  }

  // ---- 内部: 音量正規化ゲイン ------------------------------------------------

  _loadGains() {
    if (this._gains) return this._gains;
    this._gains = {};
    try {
      const raw = typeof localStorage !== 'undefined' && localStorage.getItem(GAIN_CACHE_KEY);
      if (raw) this._gains = JSON.parse(raw);
    } catch { /* 壊れたキャッシュは捨てる */ }
    return this._gains;
  }

  _gainFor(track, buffer) {
    const gains = this._loadGains();
    let g = gains[track.id];
    if (typeof g !== 'number') {
      const channels = [];
      for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
      g = Math.round(computeTrackGain(channels, buffer.sampleRate) * 1000) / 1000;
      gains[track.id] = g;
      this._scheduleGainsSave();
    }
    return g;
  }

  _scheduleGainsSave() {
    clearTimeout(this._gainsSaveTimer);
    this._gainsSaveTimer = setTimeout(() => {
      try {
        const gains = this._gains;
        const keys = Object.keys(gains);
        if (keys.length > GAIN_CACHE_MAX) {
          for (const k of keys.slice(0, keys.length - GAIN_CACHE_MAX)) delete gains[k];
        }
        localStorage?.setItem(GAIN_CACHE_KEY, JSON.stringify(gains));
      } catch { /* localStorage が使えなくても再生には影響しない */ }
    }, 2000);
  }

  // ---- 内部: 再生とギャップレス連結 -----------------------------------------

  _makeSource(buffer, gainNode) {
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gainNode);
    return source;
  }

  _makeGainNode(trackGain) {
    const g = this.ctx.createGain();
    g.gain.value = this.normalization && trackGain != null ? trackGain : 1;
    g.connect(this.masterGain);
    return g;
  }

  _makeEndedHandler(source, gen) {
    return () => {
      if (source._cancelled || gen !== this._gen) return;
      this._advance(gen);
    };
  }

  _startCurrent(track, entry, offset, when) {
    if (entry.reader) {
      this._startStream(track, entry, offset, when);
      return;
    }
    const gainNode = entry.gainNode ?? this._makeGainNode(entry.trackGain);
    const source = entry.source ?? this._makeSource(entry.buffer, gainNode);
    if (!entry.source) source.start(when, offset);
    this.current = {
      track,
      kind: 'buffer',
      buffer: entry.buffer,
      duration: entry.buffer.duration,
      trackGain: entry.trackGain,
      gainNode,
      source,
      startTime: when - offset,
    };
    source.onended = this._makeEndedHandler(source, this._gen);
  }

  /** ストリーミング再生の開始: 窓読みリーダーから動的にデコードして連結する */
  _startStream(track, entry, offset, when) {
    const reader = entry.reader;
    const gainNode = entry.gainNode ?? this._makeGainNode(entry.trackGain);
    const cur = {
      track,
      kind: 'stream',
      reader,
      duration: reader.totalSamples / reader.sampleRate,
      trackGain: entry.trackGain,
      gainNode,
      startTime: when - offset,
      segments: [],
      nextSample: Math.floor(offset * reader.sampleRate),
      epoch: 0,
      pumping: false,
      pumpTimer: null,
      buffer: null,
      source: null,
    };
    // ギャップレス連結で先頭セグメントがスケジュール済みならそのまま引き継ぐ
    if (entry.source && entry.firstBuffer) {
      cur.segments.push({ source: entry.source, startSample: 0, length: entry.firstBuffer.length });
      cur.nextSample = entry.firstBuffer.length;
    }
    this.current = cur;
    this._pumpStream(this._gen);
  }

  /**
   * ストリーム再生の心臓部: 再生位置の STREAM_AHEAD_SEC 先までデコードして
   * サンプル精度で連結し、再生済みセグメントの参照を捨てる (動的確保・動的解放)
   */
  async _pumpStream(gen) {
    const cur = this.current;
    if (!cur || cur.kind !== 'stream' || gen !== this._gen || cur.pumping) return;
    cur.pumping = true;
    const epoch = cur.epoch;
    try {
      const rate = cur.reader.sampleRate;
      while (gen === this._gen && this.current === cur && epoch === cur.epoch) {
        if (cur.nextSample >= cur.reader.totalSamples) {
          this._armStreamEnd(cur, gen);
          return;
        }
        const played = (this.ctx.currentTime - cur.startTime) * rate;
        if (cur.nextSample >= played + STREAM_AHEAD_SEC * rate) break; // 十分先までデコード済み
        const win = await cur.reader.readWindow(cur.nextSample, Math.floor(STREAM_WINDOW_SEC * rate));
        if (gen !== this._gen || this.current !== cur || epoch !== cur.epoch) return;
        if (!win.length) { // これ以上読めない: ここを終端として扱う
          cur.duration = cur.nextSample / rate;
          this._armStreamEnd(cur, gen);
          return;
        }
        if (cur.trackGain == null) {
          // ゲイン未実測なら最初の窓から求める (音が出る前に設定される)
          cur.trackGain = this._gainFromWindow(cur.track, win.channelData, rate);
          cur.gainNode.gain.value = this.normalization ? cur.trackGain : 1;
        }
        const buf = channelsToBuffer(win.channelData, win.length, rate);
        const source = this._makeSource(buf, cur.gainNode);
        source.start(cur.startTime + cur.nextSample / rate);
        cur.segments.push({ source, startSample: cur.nextSample, length: win.length });
        cur.nextSample += win.length;
        // 再生済みセグメントを解放 (参照を切れば AudioBuffer は GC される)
        const done = played - rate; // 1 秒の余裕
        while (cur.segments.length > 1 &&
               cur.segments[0].startSample + cur.segments[0].length < done) {
          cur.segments.shift();
        }
      }
      // まだ途中: 少し先でポンプを再実行
      if (gen === this._gen && this.current === cur && epoch === cur.epoch) {
        clearTimeout(cur.pumpTimer);
        cur.pumpTimer = setTimeout(() => this._pumpStream(gen), (STREAM_AHEAD_SEC / 2) * 1000);
      }
    } finally {
      cur.pumping = false;
    }
  }

  /** 最終セグメントに曲終端ハンドラを付ける */
  _armStreamEnd(cur, gen) {
    const last = cur.segments[cur.segments.length - 1];
    if (last && !last.source.onended) {
      last.source.onended = this._makeEndedHandler(last.source, gen);
    }
  }

  _cancelSource(source) {
    if (!source) return;
    source._cancelled = true;
    source.onended = null;
    try { source.stop(); } catch { /* 未 start の source は stop 不可 */ }
    try { source.disconnect(); } catch { /* already disconnected */ }
  }

  _unscheduleNext() {
    if (this.next?.source) {
      this._cancelSource(this.next.source);
      this.next.source = null;
      if (this.next.entry) {
        // 再スケジュール時に作り直すので、接続済みゲインノードも外す (リーク防止)
        try { this.next.entry.gainNode?.disconnect(); } catch { /* ignore */ }
        this.next.entry.gainNode = null;
        this.next.entry.source = null;
      }
    }
  }

  _teardownPlayback() {
    clearTimeout(this._prefetchTimer);
    if (this.current) {
      const cur = this.current;
      if (cur.kind === 'stream') {
        cur.epoch++;
        clearTimeout(cur.pumpTimer);
        for (const seg of cur.segments) this._cancelSource(seg.source);
        cur.segments = [];
        cur.reader.destroy?.();
      } else {
        this._cancelSource(cur.source);
      }
      try { cur.gainNode.disconnect(); } catch { /* ignore */ }
      this.current = null;
    }
    this._unscheduleNext();
    this._dropNext();
  }

  /** 先読み中の次曲を破棄する (取得中のソースも中断) */
  _dropNext() {
    const nx = this.next;
    if (nx) {
      if (nx.entry?.reader) {
        nx.entry.reader.destroy?.();
      } else {
        nx.sourcePromise?.then((s) => s?.cancel?.()).catch(() => {});
      }
    }
    this.next = null;
  }

  /**
   * 次曲の「デコード」を現曲の終端 45 秒前まで遅らせるタイマー。
   * (取得は _prefetchNext が再生開始直後に済ませて圧縮のまま保持している。
   *  展開まで即時に行うと非圧縮 PCM を常時 2 曲分抱えるため、直前まで待つ)
   */
  _schedulePrefetch(gen) {
    clearTimeout(this._prefetchTimer);
    const lead = 45;
    const remain = this.duration - this.currentTime;
    if (remain - lead < 0.5) {
      this._decodeNext(gen);
      return;
    }
    this._prefetchTimer = setTimeout(() => {
      if (gen === this._gen && this.current) this._decodeNext(gen);
    }, (remain - lead) * 1000);
  }

  /**
   * 次曲の「取得」だけを先に済ませる (圧縮のままメモリに保持)。
   * 展開 (デコード、非圧縮で約 100MB/5 分) は _decodeNext が終端間際に行う。
   * これで「次の曲へ」を押したときの待ちがデコードのみ (約 1 秒) になる。
   */
  _prefetchNext(gen) {
    const track = this.nextProvider?.() ?? null;
    if (!track) { this.next = null; return; }

    // エンジンで扱えない曲 (長尺など) は終端でアプリ側に委譲する
    if (!this.canPlay(track)) {
      this.next = { track, handoff: true };
      return;
    }

    // リピート 1 曲などで現曲と同じトラックならデコード結果を使い回す
    // (ストリーム再生中はリーダーを共有できないため通常の再取得に任せる)
    if (track === this.current?.track && this.current.kind === 'buffer') {
      this.next = {
        track,
        entry: { buffer: this.current.buffer, trackGain: this.current.trackGain },
        source: null,
      };
      return;
    }

    this.next = {
      track,
      // プログレッシブ取得を即開始 (受信しながらデコード段階を待つ)
      sourcePromise: createProgressiveSource(this.streamUrl(track)).catch((err) => ({ error: err })),
      decodePromise: null,
      entry: null,
      source: null,
    };
  }

  /** next の取得中ソースをデコードする (多重実行しないよう promise を共有) */
  async _ensureNextDecoded(next, gen) {
    next.decodePromise ??= (async () => {
      const source = await next.sourcePromise;
      if (!source || source.error) return { error: source?.error ?? new Error('fetch failed') };
      try {
        const entry = await this._decodeBytes(next.track, source);
        if (entry.reader) {
          // ギャップレス連結用に先頭窓だけ AudioBuffer 化しておく
          const rate = entry.reader.sampleRate;
          const win = await entry.reader.readWindow(0,
            Math.min(entry.reader.totalSamples, Math.floor(STREAM_WINDOW_SEC * rate)));
          if (win.length > 0) {
            if (entry.trackGain == null) {
              entry.trackGain = this._gainFromWindow(next.track, win.channelData, rate);
            }
            entry.firstBuffer = channelsToBuffer(win.channelData, win.length, rate);
          }
        }
        return entry;
      } catch (err) {
        return { error: err };
      }
    })();
    const entry = await next.decodePromise;
    if (gen === this._gen && this.next === next && !entry.error) {
      next.entry = entry;
    }
    return entry;
  }

  /** タイマー起点: 次曲をデコードして現曲の終端に連結する */
  async _decodeNext(gen) {
    const next = this.next;
    if (!next || next.handoff || gen !== this._gen) return;
    if (!next.entry) {
      const entry = await this._ensureNextDecoded(next, gen);
      if (gen !== this._gen || this.next !== next || entry.error) return;
    }
    this._scheduleNextIfReady();
  }

  _scheduleNextIfReady() {
    const next = this.next;
    if (!next?.entry || next.entry.error || next.source || !this.current) return;
    const buf = next.entry.firstBuffer ?? next.entry.buffer;
    if (!buf) return;
    const endTime = this.current.startTime + this.current.duration;
    if (endTime <= this.ctx.currentTime) return; // 終端を過ぎている: _advance に任せる
    const gainNode = this._makeGainNode(next.entry.trackGain);
    const source = this._makeSource(buf, gainNode);
    source.start(endTime);
    next.source = source;
    next.entry.gainNode = gainNode;
    next.entry.source = source;
  }

  /** 現曲の終端に達した: 次曲へ引き継ぐ */
  async _advance(gen) {
    const prev = this.current;
    const next = this.next;
    if (prev) {
      if (prev.kind === 'stream') {
        prev.epoch++;
        clearTimeout(prev.pumpTimer);
        prev.segments = [];
        prev.reader.destroy?.();
      }
      try { prev.gainNode.disconnect(); } catch { /* ignore */ }
      this.current = null;
    }
    if (!next) { this.onqueueend?.(); return; }

    if (next.handoff) {
      this.next = null;
      this.onhandoff?.(next.track);
      return;
    }

    const entry = next.entry ?? await this._ensureNextDecoded(next, gen);
    if (gen !== this._gen) return;
    if (!entry || entry.error) {
      this.next = null;
      if (entry?.error && next.track) {
        // 次曲の取得/デコードに失敗しても再生列を止めない: <audio> 再生に委譲する
        console.warn('次曲のデコードに失敗したため <audio> 再生に切り替えます:', entry.error);
        this.onhandoff?.(next.track);
        return;
      }
      this.onqueueend?.();
      return;
    }

    const now = this.ctx.currentTime;
    let startTime = now;
    if (next.source && prev) {
      // サンプル精度でスケジュール済み: 実際の開始時刻は前曲の終端
      startTime = prev.startTime + prev.duration;
    }
    this.next = null;
    this._startCurrent(next.track, entry, 0, startTime);
    this.ontrackstart?.(next.track, { auto: true });
    this._prefetchNext(gen);
    this._schedulePrefetch(gen);
  }
}

/** チャンネル別 Float32Array 群を AudioBuffer にする (窓読みセグメント用) */
function channelsToBuffer(channelData, length, sampleRate) {
  const buffer = new AudioBuffer({
    numberOfChannels: channelData.length,
    length,
    sampleRate,
  });
  channelData.forEach((data, ch) => {
    buffer.copyToChannel(data.length === length && data.byteOffset === 0
      ? data : new Float32Array(data.subarray ? data.subarray(0, length) : data), ch);
  });
  return buffer;
}

/** {channelData, sampleRate, length} 形式の PCM を AudioBuffer にする */
function pcmToAudioBuffer(pcm) {
  if (!pcm.length) throw new Error('PCM データが空です');
  const buffer = new AudioBuffer({
    numberOfChannels: pcm.channelData.length,
    length: pcm.length,
    sampleRate: pcm.sampleRate,
  });
  pcm.channelData.forEach((data, ch) => {
    buffer.copyToChannel(
      data.byteOffset === 0 && data.length === pcm.length ? data : new Float32Array(data), ch);
  });
  return buffer;
}
