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

const ENGINE_EXTS = new Set([
  '.mp3', '.aac', '.m4a', '.m4b', '.flac', '.wav', '.aif', '.aiff', '.aifc',
]);
const GAIN_CACHE_KEY = 'macca-track-gains';
const GAIN_CACHE_MAX = 5000;

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
  }

  /** このエンジンでデコード・再生できる形式・長さか */
  canPlay(track) {
    if (typeof AudioContext === 'undefined' || !ENGINE_EXTS.has(track.ext)) return false;
    if (track.duration && track.duration > MAX_ENGINE_DURATION) return false; // 長尺は <audio> へ
    return true;
  }

  get playingTrack() { return this.current?.track ?? null; }
  get paused() { return this.ctx ? this.ctx.state !== 'running' : true; }
  get duration() { return this.current?.buffer.duration ?? 0; }

  get currentTime() {
    if (!this.current || !this.ctx) return 0;
    const t = this.ctx.currentTime - this.current.startTime;
    return Math.min(Math.max(t, 0), this.current.buffer.duration);
  }

  /** トラックを (ユーザー操作起点で) 再生する */
  async play(track) {
    const gen = ++this._gen;
    this._teardownPlayback();

    const decoded = await this._decode(track, { forPlayback: true });
    if (gen !== this._gen) return; // 待っている間に別の再生が始まった

    await this._ensureContext(decoded.buffer.sampleRate);
    if (gen !== this._gen) return;
    if (this.ctx.state !== 'running') await this.ctx.resume().catch(() => {});

    this._startCurrent(track, decoded, 0, this.ctx.currentTime);
    this.ontrackstart?.(track, { auto: false });
    this._prefetchNext(gen);
  }

  pause() { this.ctx?.suspend().catch(() => {}); }
  resume() { this.ctx?.resume().catch(() => {}); }
  toggle() { this.paused ? this.resume() : this.pause(); }

  seek(seconds) {
    if (!this.current || !this.ctx) return;
    const cur = this.current;
    const offset = Math.min(Math.max(seconds, 0), cur.buffer.duration - 0.05);
    this._cancelSource(cur.source);
    this._unscheduleNext();
    const now = this.ctx.currentTime;
    cur.source = this._makeSource(cur.buffer, cur.gainNode);
    cur.source.onended = this._makeEndedHandler(cur.source, this._gen);
    cur.source.start(now, offset);
    cur.startTime = now - offset;
    this._scheduleNextIfReady();
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
      if (slot?.gainNode) slot.gainNode.gain.value = on ? slot.trackGain : 1;
    }
  }

  /** 再生モード変更などで、先読み済みの次曲を破棄して取り直す */
  refreshNext() {
    if (!this.current) return;
    this._unscheduleNext();
    this.next = null;
    this._prefetchNext(this._gen);
  }

  // ---- 内部: コンテキスト管理 ----------------------------------------------

  async _ensureContext(sampleRate) {
    if (this.ctx && (!sampleRate || this.ctx.sampleRate === sampleRate)) return;
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
  }

  // ---- 内部: デコード -------------------------------------------------------

  async _fetchBytes(track) {
    const res = await fetch(this.streamUrl(track));
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async _alacModule() {
    this._alacPromise ??= (async () => {
      const res = await fetch(this.wasmUrl);
      if (!res.ok) throw new Error('alac.wasm が読み込めません');
      return loadAlac(await res.arrayBuffer());
    })();
    return this._alacPromise;
  }

  /**
   * トラックをデコードして {buffer, trackGain} を返す。
   * forPlayback 時のみ AudioContext を音源レートで作り直してよい。
   */
  async _decode(track, { forPlayback = false } = {}) {
    const ext = track.ext;
    const bytes = await this._fetchBytes(track);
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
    g.gain.value = this.normalization ? trackGain : 1;
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
    const gainNode = entry.gainNode ?? this._makeGainNode(entry.trackGain);
    const source = entry.source ?? this._makeSource(entry.buffer, gainNode);
    if (!entry.source) source.start(when, offset);
    this.current = {
      track,
      buffer: entry.buffer,
      trackGain: entry.trackGain,
      gainNode,
      source,
      startTime: when - offset,
    };
    source.onended = this._makeEndedHandler(source, this._gen);
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
      if (this.next.entry) this.next.entry.source = null;
    }
  }

  _teardownPlayback() {
    if (this.current) {
      this._cancelSource(this.current.source);
      try { this.current.gainNode.disconnect(); } catch { /* ignore */ }
      this.current = null;
    }
    this._unscheduleNext();
    this.next = null;
  }

  /** 次曲を先読みデコードし、可能なら現曲の終端にスケジュールする */
  _prefetchNext(gen) {
    const track = this.nextProvider?.() ?? null;
    if (!track) { this.next = null; return; }

    // エンジンで扱えない曲 (長尺など) は終端でアプリ側に委譲する
    if (!this.canPlay(track)) {
      this.next = { track, handoff: true };
      return;
    }

    // リピート 1 曲などで現曲と同じトラックならデコード結果を使い回す
    const promise = (track === this.current?.track)
      ? Promise.resolve({ buffer: this.current.buffer, trackGain: this.current.trackGain })
      : this._decode(track).catch((err) => ({ error: err }));

    this.next = { track, promise, entry: null, source: null };
    promise.then((entry) => {
      if (gen !== this._gen || this.next?.promise !== promise) return;
      this.next.entry = entry;
      this._scheduleNextIfReady();
    });
  }

  _scheduleNextIfReady() {
    const next = this.next;
    if (!next?.entry || next.entry.error || next.source || !this.current) return;
    const endTime = this.current.startTime + this.current.buffer.duration;
    if (endTime <= this.ctx.currentTime) return; // 終端を過ぎている: _advance に任せる
    const gainNode = this._makeGainNode(next.entry.trackGain);
    const source = this._makeSource(next.entry.buffer, gainNode);
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
      try { prev.gainNode.disconnect(); } catch { /* ignore */ }
      this.current = null;
    }
    if (!next) { this.onqueueend?.(); return; }

    if (next.handoff) {
      this.next = null;
      this.onhandoff?.(next.track);
      return;
    }

    const entry = next.entry ?? await next.promise;
    if (gen !== this._gen) return;
    if (!entry || entry.error) {
      this.next = null;
      if (entry?.error && next.track) {
        // 次曲のデコードに失敗しても再生列を止めない: <audio> 再生に委譲する
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
      startTime = prev.startTime + prev.buffer.duration;
    }
    this.next = null;
    this._startCurrent(next.track, entry, 0, startTime);
    this.ontrackstart?.(next.track, { auto: true });
    this._prefetchNext(gen);
  }
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
