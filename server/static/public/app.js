import { AudioEngine } from './player/engine.js';

// ---- 状態 -----------------------------------------------------------------

const state = {
  tracks: [],
  sources: [],
  ffmpeg: false,
  dir: '',
  view: 'songs',          // songs | albums | artists
  search: '',
  filterArtist: null,
  filterAlbum: null,      // アルバムキー
  filterFormats: new Set(),
  sortKey: null,
  sortAsc: true,
  renderLimit: 1000,
  queue: [],              // 再生キュー (クリックした曲のアルバム全体)
  queueIdx: -1,
  // album: アルバム再生(末尾で停止) / one: 1回再生 / repeat-one: 1曲リピート
  // repeat-album: アルバムリピート / shuffle-album: アルバムランダム
  playMode: 'album',
  shuffleBag: [],         // アルバムランダムの残り曲 (一巡するまで再シャッフルしない)
  playing: null,          // 再生中トラック
  loading: false,         // エンジンのfetch+デコード待ち
  transcoding: false,
  mode: 'engine',         // engine (Web Audio) | element (<audio> フォールバック)
  normalize: localStorage.getItem('macca-normalize') === '1',
};

const $ = (sel) => document.querySelector(sel);
const audio = $('#audio');
const collator = new Intl.Collator('ja');

// Web Audio 再生エンジン (ギャップレス / ALAC・AIFF 内蔵デコード / 音量正規化)
const engine = typeof AudioContext !== 'undefined' ? new AudioEngine() : null;

// ---- ユーティリティ -------------------------------------------------------

function fmtTime(sec) {
  if (sec == null || !isFinite(sec)) return '–:––';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function fmtSize(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  return Math.round(bytes / 1e3) + ' KB';
}

function formatLabel(t) {
  if (t.codec === 'alac') return 'ALAC';
  if (t.codec === 'aac') return 'AAC';
  if (t.codec === 'flac') return 'FLAC';
  if (t.codec === 'mp3') return 'MP3';
  if (t.codec === 'aiff' || t.codec === 'aifc') return 'AIFF';
  if (t.codec === 'pcm') return 'WAV';
  return t.ext.replace('.', '').toUpperCase();
}

function badgeClass(t) {
  const l = formatLabel(t).toLowerCase();
  return ['alac', 'aac', 'flac', 'mp3', 'aiff', 'pcm'].includes(l) ? l : (l === 'wav' ? 'pcm' : '');
}

function mimeFor(t) {
  switch (t.codec) {
    case 'alac': return 'audio/mp4; codecs="alac"';
    case 'aac': return 'audio/mp4; codecs="mp4a.40.2"';
    case 'flac': return t.ext === '.m4a' ? 'audio/mp4; codecs="flac"' : 'audio/flac';
    case 'mp3': return 'audio/mpeg';
    case 'aiff': case 'aifc': return 'audio/aiff';
    case 'pcm': return 'audio/wav';
    default: {
      const map = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg; codecs=opus', '.aif': 'audio/aiff', '.aiff': 'audio/aiff' };
      return map[t.ext] ?? 'audio/mpeg';
    }
  }
}

function canPlayNatively(t) {
  return audio.canPlayType(mimeFor(t)) !== '';
}

/** エンジン内蔵デコーダ・ブラウザ・サーバ変換のいずれかで再生できるか */
function canPlayTrack(t) {
  return (engine?.canPlay(t)) || canPlayNatively(t) || state.ffmpeg;
}

function albumKey(t) {
  return `${t.album ?? '(不明なアルバム)'}\x1f${t.albumArtist ?? t.artist ?? ''}`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastTimer = null;
function toast(msg, ms = 3500) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ---- フィルタリング -------------------------------------------------------

function visibleTracks() {
  let list = state.tracks;
  if (state.filterArtist !== null) {
    list = list.filter((t) => (t.artist ?? '') === state.filterArtist || (t.albumArtist ?? '') === state.filterArtist);
  }
  if (state.filterAlbum !== null) {
    list = list.filter((t) => albumKey(t) === state.filterAlbum);
  }
  if (state.filterFormats.size > 0) {
    list = list.filter((t) => state.filterFormats.has(formatLabel(t)));
  }
  if (state.search) {
    const q = state.search.toLowerCase();
    list = list.filter((t) =>
      t.title.toLowerCase().includes(q) ||
      (t.artist ?? '').toLowerCase().includes(q) ||
      (t.album ?? '').toLowerCase().includes(q));
  }
  if (state.sortKey) {
    const k = state.sortKey;
    const dir = state.sortAsc ? 1 : -1;
    list = [...list].sort((a, b) => {
      const va = a[k], vb = b[k];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === 'number') return (va - vb) * dir;
      return collator.compare(String(va), String(vb)) * dir;
    });
  } else if (state.filterAlbum !== null) {
    list = [...list].sort((a, b) => (a.track ?? 9999) - (b.track ?? 9999));
  }
  return list;
}

// ---- 描画: 曲一覧 ---------------------------------------------------------

const SONG_COLUMNS = [
  ['track', '#'],
  ['title', 'タイトル'],
  ['artist', 'アーティスト'],
  ['album', 'アルバム'],
  ['duration', '時間'],
  ['codec', '形式'],
];

function renderSongs(container) {
  const list = visibleTracks();
  const filtered = state.filterArtist !== null || state.filterAlbum !== null;

  let head = '';
  if (filtered) {
    const label = state.filterAlbum !== null
      ? state.filterAlbum.split('\x1f')[0]
      : state.filterArtist || '(不明なアーティスト)';
    head = `<div class="view-head"><h2>${esc(label)}</h2>
      <span class="sub">${list.length} 曲</span>
      <button class="clear-filter" id="clear-filter">✕ フィルタ解除</button></div>`;
  }

  const ths = SONG_COLUMNS.map(([key, label]) => {
    const arrow = state.sortKey === key ? (state.sortAsc ? ' ▲' : ' ▼') : '';
    return `<th data-sort="${key}">${label}${arrow}</th>`;
  }).join('');

  const shown = list.slice(0, state.renderLimit);
  const rows = shown.map((t) => {
    const playing = state.playing?.id === t.id ? ' playing' : '';
    const native = canPlayTrack(t);
    return `<tr class="song${playing}" data-id="${t.id}">
      <td class="num">${t.track ?? ''}</td>
      <td title="${esc(t.path)}">${esc(t.title)}${native ? '' : ' <span class="badge warn" title="このブラウザでは再生できません">再生不可</span>'}</td>
      <td><span class="link" data-artist="${esc(t.artist ?? '')}">${esc(t.artist ?? '—')}</span></td>
      <td><span class="link" data-album="${esc(albumKey(t))}">${esc(t.album ?? '—')}</span></td>
      <td class="dur">${fmtTime(t.duration)}</td>
      <td class="fmt"><span class="badge ${badgeClass(t)}">${formatLabel(t)}</span></td>
    </tr>`;
  }).join('');

  const more = list.length > state.renderLimit
    ? `<button class="more-btn" id="more-btn">さらに表示 (残り ${list.length - state.renderLimit} 曲)</button>` : '';

  container.innerHTML = `${head}<table class="songs">
    <thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table>${more}`;

  container.querySelectorAll('th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.sortKey === key) {
        if (state.sortAsc) state.sortAsc = false;
        else { state.sortKey = null; state.sortAsc = true; }
      } else { state.sortKey = key; state.sortAsc = true; }
      render();
    });
  });
  container.querySelectorAll('tr.song').forEach((tr) => {
    tr.addEventListener('dblclick', () => playFromList(tr.dataset.id));
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.link')) return;
      playFromList(tr.dataset.id);
    });
  });
  container.querySelectorAll('[data-artist]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      state.filterArtist = el.dataset.artist;
      state.filterAlbum = null;
      setView('songs');
    });
  });
  container.querySelectorAll('[data-album]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      state.filterAlbum = el.dataset.album;
      state.filterArtist = null;
      setView('songs');
    });
  });
  $('#clear-filter')?.addEventListener('click', () => {
    state.filterArtist = null;
    state.filterAlbum = null;
    render();
  });
  $('#more-btn')?.addEventListener('click', () => {
    state.renderLimit += 2000;
    render();
  });
}

// ---- 描画: アルバム / アーティスト ---------------------------------------

function renderAlbums(container) {
  const groups = new Map();
  for (const t of visibleTracks()) {
    const key = albumKey(t);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const albums = [...groups.entries()].sort((a, b) => collator.compare(a[0], b[0]));

  const cards = albums.map(([key, ts]) => {
    const [name, artist] = key.split('\x1f');
    const artTrack = ts.find((t) => t.hasArt) ?? ts[0];
    return `<div class="album-card" data-album="${esc(key)}">
      <div class="cover"><img loading="lazy" src="/api/artwork/${artTrack.id}" alt=""
        onerror="this.remove()"><span class="cover-fallback">♪</span></div>
      <div class="name">${esc(name)}</div>
      <div class="sub">${esc(artist || '—')} · ${ts.length} 曲</div>
    </div>`;
  }).join('');

  container.innerHTML = `<div class="view-head"><h2>アルバム</h2>
    <span class="sub">${albums.length} 枚</span></div>
    <div class="album-grid">${cards}</div>`;

  container.querySelectorAll('.album-card').forEach((card) => {
    card.addEventListener('click', () => {
      state.filterAlbum = card.dataset.album;
      state.filterArtist = null;
      setView('songs');
    });
  });
}

function renderArtists(container) {
  const counts = new Map();
  for (const t of visibleTracks()) {
    const name = t.artist ?? '(不明なアーティスト)';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const artists = [...counts.entries()].sort((a, b) => collator.compare(a[0], b[0]));
  const rows = artists.map(([name, n]) =>
    `<div class="artist-row" data-artist="${esc(name === '(不明なアーティスト)' ? '' : name)}">
      <span>${esc(name)}</span><span class="count">${n} 曲</span></div>`).join('');

  container.innerHTML = `<div class="view-head"><h2>アーティスト</h2>
    <span class="sub">${artists.length} 組</span></div>
    <div class="artist-list">${rows}</div>`;

  container.querySelectorAll('.artist-row').forEach((row) => {
    row.addEventListener('click', () => {
      state.filterArtist = row.dataset.artist;
      state.filterAlbum = null;
      setView('songs');
    });
  });
}

function render() {
  const container = $('#content');
  if (state.view === 'albums') renderAlbums(container);
  else if (state.view === 'artists') renderArtists(container);
  else renderSongs(container);
}

function setView(view) {
  state.view = view;
  state.renderLimit = 1000;
  document.querySelectorAll('.nav-item').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === view));
  if (location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
  render();
  $('#content').scrollTop = 0;
}

// ---- フォーマットフィルタ / 統計 ------------------------------------------

function renderFormatChips() {
  const formats = new Map();
  for (const t of state.tracks) {
    const l = formatLabel(t);
    formats.set(l, (formats.get(l) ?? 0) + 1);
  }
  const el = $('#fmt-filters');
  el.innerHTML = [...formats.entries()].sort((a, b) => b[1] - a[1]).map(([l, n]) =>
    `<button class="fmt-chip${state.filterFormats.has(l) ? ' active' : ''}" data-fmt="${l}">${l} <small>${n}</small></button>`).join('');
  el.querySelectorAll('.fmt-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const f = chip.dataset.fmt;
      if (state.filterFormats.has(f)) state.filterFormats.delete(f);
      else state.filterFormats.add(f);
      renderFormatChips();
      render();
    });
  });
}

function renderStats() {
  const totalDur = state.tracks.reduce((s, t) => s + (t.duration ?? 0), 0);
  const totalSize = state.tracks.reduce((s, t) => s + t.size, 0);
  $('#stats').textContent =
    `${state.tracks.length.toLocaleString()} 曲 · ${(totalDur / 3600).toFixed(1)} 時間 · ${fmtSize(totalSize)}`;
}

// ---- 再生 -----------------------------------------------------------------

function playFromList(id) {
  const t = visibleTracks().find((x) => x.id === id);
  if (!t) return;
  // 再生キューはクリックした曲のアルバム全体 (トラック番号順)
  const key = albumKey(t);
  const album = state.tracks
    .filter((x) => albumKey(x) === key)
    .sort((a, b) => (a.track ?? 9999) - (b.track ?? 9999) || collator.compare(a.title, b.title));
  state.queue = album;
  state.queueIdx = album.indexOf(t);
  state.shuffleBag = [];
  playTrack(t);
}

// ---- 再生モード -------------------------------------------------------------

/** アルバムランダム: 全曲を一巡するまで再シャッフルしない袋方式 */
function drawFromShuffleBag() {
  if (state.shuffleBag.length === 0) {
    const idxs = state.queue.map((_, i) => i)
      .filter((i) => i !== state.queueIdx || state.queue.length === 1);
    for (let i = idxs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [idxs[i], idxs[j]] = [idxs[j], idxs[i]];
    }
    state.shuffleBag = idxs;
  }
  return state.shuffleBag.pop() ?? -1;
}

/** 曲が終わったときの次のキュー位置 (-1 = 停止) */
function nextQueueIdx() {
  const n = state.queue.length;
  if (n === 0) return -1;
  switch (state.playMode) {
    case 'one': return -1;
    case 'repeat-one': return state.queueIdx;
    case 'shuffle-album': return drawFromShuffleBag();
    case 'repeat-album': return (state.queueIdx + 1) % n;
    default: return state.queueIdx + 1 < n ? state.queueIdx + 1 : -1; // album
  }
}

function updateNowPlayingUI(t) {
  $('#player').classList.remove('hidden');
  $('#np-title').textContent = t.title;
  $('#np-artist').textContent = [t.artist, t.album].filter(Boolean).join(' — ');

  const badge = $('#np-badge');
  badge.hidden = false;
  badge.className = `badge ${badgeClass(t)}`;
  badge.textContent = formatLabel(t) + (state.transcoding ? ' → WAV' : '');

  const art = $('#np-art');
  art.src = `/api/artwork/${t.id}`;
  art.hidden = false;
  $('#np-art-placeholder').style.display = 'none';
  art.onerror = () => {
    art.hidden = true;
    $('#np-art-placeholder').style.display = 'flex';
  };

  $('#seekbar').disabled = state.mode === 'element' && state.transcoding;
  updatePlayButton();
  updateMediaSession(t);
  document.querySelectorAll('tr.song').forEach((tr) =>
    tr.classList.toggle('playing', tr.dataset.id === t.id));
  document.title = `${t.title} — macca`;
}

/** <audio> タグでの再生 (エンジン非対応形式・エンジン失敗時のフォールバック) */
function playViaElement(t) {
  state.mode = 'element';
  const native = canPlayNatively(t);
  state.transcoding = !native && state.ffmpeg;
  if (!native && !state.ffmpeg) {
    toast(`${formatLabel(t)} はこのブラウザでは再生できません。Safari を使うか、サーバ側に ffmpeg をインストールしてください。`);
  }
  audio.src = `/api/stream/${t.id}${state.transcoding ? '?transcode=1' : ''}`;
  audio.play().catch((err) => {
    if (err.name !== 'AbortError') toast(`再生エラー: ${t.title}`);
  });
}

function playTrack(t) {
  state.playing = t;
  state.transcoding = false;

  if (engine && engine.canPlay(t)) {
    state.mode = 'engine';
    audio.pause();
    audio.removeAttribute('src');
    state.loading = true; // 大きなロスレスはfetch+デコードに数秒かかるため表示で示す
    engine.play(t).then(() => {
      if (state.playing === t) {
        state.loading = false;
        updatePlayButton();
      }
    }).catch((err) => {
      console.warn('エンジン再生に失敗、<audio> にフォールバックします:', err);
      if (state.playing === t) {
        state.loading = false;
        playViaElement(t);
        updateNowPlayingUI(t);
      }
    });
  } else {
    engine?.stop();
    state.loading = false;
    playViaElement(t);
  }
  updateNowPlayingUI(t);
}

function playNext(auto = false) {
  let idx;
  if (auto) {
    idx = nextQueueIdx();
  } else if (state.playMode === 'shuffle-album') {
    idx = drawFromShuffleBag();
  } else {
    // 手動の「次へ」はモードによらずアルバム内を進む
    idx = state.queueIdx + 1;
    if (idx >= state.queue.length) {
      idx = state.playMode === 'repeat-album' ? 0 : -1;
    }
  }
  if (idx === -1 || !state.queue[idx]) {
    updatePlayButton();
    return; // 停止
  }
  state.queueIdx = idx;
  playTrack(state.queue[idx]);
}

function playPrev() {
  const cur = state.mode === 'engine' && engine ? engine.currentTime : audio.currentTime;
  if (cur > 3) {
    if (state.mode === 'engine' && engine) engine.seek(0);
    else audio.currentTime = 0;
    return;
  }
  let idx = state.queueIdx - 1;
  if (idx < 0) idx = state.playMode === 'repeat-album' ? state.queue.length - 1 : 0;
  state.queueIdx = idx;
  if (state.queue[idx]) playTrack(state.queue[idx]);
}

function isPaused() {
  return state.mode === 'engine' && engine ? engine.paused : audio.paused;
}

function togglePlay() {
  if (state.mode === 'engine' && engine) {
    if (!engine.playingTrack) return;
    engine.toggle();
    updatePlayButton();
  } else {
    if (!audio.src) return;
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  }
}

function updatePlayButton() {
  $('#btn-play').textContent = state.loading ? '…' : isPaused() ? '▶' : '⏸';
}

function updateMediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  navigator.mediaSession.metadata = new MediaMetadata({
    title: t.title,
    artist: t.artist ?? '',
    album: t.album ?? '',
    artwork: [{ src: `/api/artwork/${t.id}`, sizes: '512x512' }],
  });
  navigator.mediaSession.setActionHandler('play', togglePlay);
  navigator.mediaSession.setActionHandler('pause', togglePlay);
  navigator.mediaSession.setActionHandler('previoustrack', playPrev);
  navigator.mediaSession.setActionHandler('nexttrack', () => playNext());
}

// ---- エンジンのコールバック (ギャップレス自動連結・進行表示) ---------------

if (engine) {
  engine.setNormalization(state.normalize);
  engine.nextProvider = () => {
    const idx = nextQueueIdx();
    return idx === -1 ? null : state.queue[idx] ?? null;
  };
  engine.ontrackstart = (t, { auto }) => {
    if (!auto) return; // 手動再生は playTrack 側で UI 更新済み
    state.playing = t;
    state.transcoding = false;
    const idx = state.queue.indexOf(t);
    if (idx !== -1) state.queueIdx = idx;
    updateNowPlayingUI(t);
  };
  engine.onqueueend = () => updatePlayButton();
  // 次曲がエンジン非対応 (15 分超の長尺など) の場合は <audio> 再生に引き継ぐ
  engine.onhandoff = (t) => {
    const idx = state.queue.indexOf(t);
    if (idx !== -1) state.queueIdx = idx;
    playTrack(t);
  };

  setInterval(() => {
    if (state.mode !== 'engine' || !engine.playingTrack) return;
    updatePlayButton(); // OS割り込みで止まった場合もボタン表示を実状態に合わせる
    const dur = engine.duration;
    $('#time-cur').textContent = fmtTime(engine.currentTime);
    $('#time-total').textContent = fmtTime(dur);
    if (dur > 0 && !seekDragging) {
      $('#seekbar').value = Math.round((engine.currentTime / dur) * 1000);
    }
    if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession) {
      try {
        navigator.mediaSession.setPositionState(
          { duration: dur, position: Math.min(engine.currentTime, dur) });
      } catch { /* ignore */ }
    }
  }, 250);
}

// ---- プレーヤ UI イベント -------------------------------------------------

audio.addEventListener('timeupdate', () => {
  if (state.mode !== 'element') return;
  const dur = isFinite(audio.duration) ? audio.duration : state.playing?.duration;
  $('#time-cur').textContent = fmtTime(audio.currentTime);
  $('#time-total').textContent = fmtTime(dur);
  if (dur > 0 && !seekDragging) {
    $('#seekbar').value = Math.round((audio.currentTime / dur) * 1000);
  }
});
audio.addEventListener('ended', () => {
  if (state.mode !== 'element') return;
  if (state.playMode === 'repeat-one') {
    audio.currentTime = 0;
    audio.play().catch(() => {});
  } else {
    playNext(true);
  }
});
audio.addEventListener('play', updatePlayButton);
audio.addEventListener('pause', updatePlayButton);
// バッファ待ち (SDの起床待ち等) を「…」で見えるようにする
audio.addEventListener('waiting', () => {
  if (state.mode === 'element') { state.loading = true; updatePlayButton(); }
});
audio.addEventListener('playing', () => {
  state.loading = false;
  updatePlayButton();
});
audio.addEventListener('error', () => {
  if (!audio.src) return;
  const t = state.playing;
  if (t && !canPlayNatively(t) && !state.ffmpeg) return; // 既に警告済み
  if (t) toast(`再生できませんでした: ${t.title}`);
});

let seekDragging = false;
const seekbar = $('#seekbar');
seekbar.addEventListener('input', () => { seekDragging = true; });
seekbar.addEventListener('change', () => {
  if (state.mode === 'engine' && engine) {
    const dur = engine.duration;
    if (dur > 0) engine.seek((seekbar.value / 1000) * dur);
  } else {
    const dur = isFinite(audio.duration) ? audio.duration : state.playing?.duration;
    if (dur > 0) {
      audio.currentTime = (seekbar.value / 1000) * dur;
      // シークは再生意図とみなす (エンジン側と同じ挙動)
      if (audio.paused) audio.play().catch(() => {});
    }
  }
  seekDragging = false;
  updatePlayButton();
});

$('#btn-play').addEventListener('click', togglePlay);
$('#btn-next').addEventListener('click', () => playNext());
$('#btn-prev').addEventListener('click', playPrev);

const modeSel = $('#play-mode');
{
  const saved = localStorage.getItem('macca-playmode');
  if (['album', 'one', 'repeat-one', 'repeat-album', 'shuffle-album'].includes(saved)) {
    state.playMode = saved;
  }
  modeSel.value = state.playMode;
}
modeSel.addEventListener('change', () => {
  state.playMode = modeSel.value;
  localStorage.setItem('macca-playmode', state.playMode);
  state.shuffleBag = [];
  if (state.mode === 'engine') engine?.refreshNext(); // 先読み済みの次曲を取り直す
});

const volbar = $('#volbar');
volbar.value = localStorage.getItem('macca-volume') ?? 100;
audio.volume = volbar.value / 100;
engine?.setVolume(volbar.value / 100);
volbar.addEventListener('input', () => {
  audio.volume = volbar.value / 100;
  engine?.setVolume(volbar.value / 100);
  localStorage.setItem('macca-volume', volbar.value);
});

const normBtn = $('#btn-norm');
if (engine) {
  normBtn.classList.toggle('on', state.normalize);
  normBtn.addEventListener('click', () => {
    state.normalize = !state.normalize;
    engine.setNormalization(state.normalize);
    normBtn.classList.toggle('on', state.normalize);
    localStorage.setItem('macca-normalize', state.normalize ? '1' : '0');
    toast(state.normalize ? '音量正規化: オン (曲間の音量差を揃えます)' : '音量正規化: オフ');
  });
} else {
  normBtn.hidden = true;
}

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowRight' && e.shiftKey) playNext();
  else if (e.key === 'ArrowLeft' && e.shiftKey) playPrev();
});

// ---- デバイス (リムーバブルストレージ) --------------------------------------

let devices = [];
let deviceOpBusy = false; // スキャン・固定などの操作中は定期再描画で表示を巻き戻さない

async function refreshDevices() {
  if (deviceOpBusy) return;
  try {
    const res = await fetch('/api/devices');
    devices = (await res.json()).devices ?? [];
  } catch {
    devices = [];
  }
  if (deviceOpBusy) return;
  renderDevices();
}

function renderDevices() {
  const el = $('#devices');
  const sources = state.sources ?? [];
  // 固定済みだが今は検出されていないソース (未接続の NAS など) も一覧に残す
  const offline = sources.filter((s) => s.pinned && !devices.some((d) => d.id === s.id));
  if (devices.length === 0 && offline.length === 0) {
    el.innerHTML = '<div class="dev-empty">未接続</div>';
    return;
  }
  const pinTitle = '固定ライブラリ: 次回起動時も自動で読み込む (スキャン結果を保存)';
  el.innerHTML = devices.map((d) => {
    const src = sources.find((s) => s.id === d.id);
    const count = src ? `${src.tracks} 曲` : '';
    const pinned = Boolean(src?.pinned);
    const pin = `<label class="dev-pin" title="${pinTitle}"><input type="checkbox" data-pin="${d.id}" data-path="${esc(d.path)}"${pinned ? ' checked' : ''}>固定</label>`;
    const btn = pinned ? ''
      : d.scanned
        ? `<button class="dev-btn" data-eject="${d.id}" title="一覧から外す (ファイルには触れません)">✕</button>`
        : `<button class="dev-btn" data-scan="${esc(d.path)}">スキャン</button>`;
    return `<div class="dev-row" title="${esc(d.path)}">
      <div class="dev-name">💾 ${esc(d.label)}</div>
      <div class="dev-actions"><span class="dev-count">${count}</span>${pin}${btn}</div></div>`;
  }).join('') + offline.map((s) => `<div class="dev-row" title="${esc(s.dir)}">
      <div class="dev-name">💾 ${esc(s.label)}</div>
      <div class="dev-actions"><span class="dev-count">${s.tracks ? `${s.tracks} 曲` : '未接続'}</span>
      <label class="dev-pin" title="固定を外すと一覧と記録から消えます"><input type="checkbox" data-unpin-remove="${s.id}" checked>固定</label></div></div>`).join('');

  el.querySelectorAll('[data-scan]').forEach((b) => b.addEventListener('click', async () => {
    deviceOpBusy = true;
    b.disabled = true;
    b.textContent = 'スキャン中…';
    try {
      const res = await fetch('/api/source', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: b.dataset.scan }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? res.status);
      applyLibrary(json);
      toast('デバイスをスキャンしました');
    } catch (err) {
      toast(`デバイスのスキャンに失敗しました: ${err.message}`);
    }
    deviceOpBusy = false;
    refreshDevices();
  }));
  el.querySelectorAll('[data-eject]').forEach((b) => b.addEventListener('click', async () => {
    deviceOpBusy = true;
    try {
      const res = await fetch(`/api/source/${b.dataset.eject}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? res.status);
      applyLibrary(json);
    } catch (err) {
      toast(`取り外しに失敗しました: ${err.message}`);
    }
    deviceOpBusy = false;
    refreshDevices();
  }));
  el.querySelectorAll('[data-pin]').forEach((c) => c.addEventListener('change', async () => {
    deviceOpBusy = true;
    c.disabled = true;
    const scanned = devices.find((d) => d.id === c.dataset.pin)?.scanned;
    // 未スキャンから固定する場合はスキャンを伴うので進行表示を出す
    const countEl = c.closest('.dev-row')?.querySelector('.dev-count');
    if (c.checked && !scanned && countEl) countEl.textContent = 'スキャン中…';
    try {
      // 未スキャンのデバイスを固定にした場合はスキャンと固定を一度に行う
      const res = c.checked && !scanned
        ? await fetch('/api/source', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: c.dataset.path, pin: true }),
          })
        : await fetch(`/api/source/${c.dataset.pin}/pin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pinned: c.checked }),
          });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? res.status);
      applyLibrary(json);
      toast(c.checked ? '固定ライブラリにしました (次回起動時も自動で読み込みます)' : '固定を解除しました');
    } catch (err) {
      toast(`固定の変更に失敗しました: ${err.message}`);
    }
    deviceOpBusy = false;
    refreshDevices();
  }));
  el.querySelectorAll('[data-unpin-remove]').forEach((c) => c.addEventListener('change', async () => {
    deviceOpBusy = true;
    c.disabled = true;
    try {
      const res = await fetch(`/api/source/${c.dataset.unpinRemove}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? res.status);
      applyLibrary(json);
      toast('固定を解除しました');
    } catch (err) {
      toast(`固定の解除に失敗しました: ${err.message}`);
    }
    deviceOpBusy = false;
    refreshDevices();
  }));
}

// ---- デバッグモード (メモリ・CPU 表示) --------------------------------------

let debugTimer = null;

async function updateDebugPanel() {
  const panel = $('#debug-panel');
  const lines = [];
  try {
    const res = await fetch('/api/stats');
    const st = res.ok ? await res.json() : null;
    if (typeof st?.rss !== 'number') {
      lines.push('サーバ: 旧バージョンです (アプリを再起動すると表示されます)');
    } else {
      const cpu = st.cpu >= 0 ? `${st.cpu.toFixed(1)}%` : '—';
      lines.push(`サーバ: ${(st.rss / 1048576).toFixed(1)} MB · CPU ${cpu}`);
    }
  } catch {
    lines.push('サーバ: 取得失敗');
  }
  if (performance.memory) {
    lines.push(`ブラウザ: ヒープ ${(performance.memory.usedJSHeapSize / 1048576).toFixed(1)} MB`);
  }
  if (engine?.current) {
    const c = engine.current;
    lines.push(c.kind === 'stream'
      ? `エンジン: stream · セグメント ${c.segments.length} 保持`
      : 'エンジン: buffer (全体デコード)');
  }
  if (engine) {
    const s = engine.stats;
    const counters = `p${s.play} a${s.advance} d${s.decodeNext} s${s.schedule} P${s.pump}/${s.pumpLoop}`;
    lines.push(`内部: ${counters}`);
    // フリーズしてもタブタイトルは残るので、診断の手がかりとして常時書き出す
    const t = state.playing ? `${state.playing.title} — macca` : 'macca';
    document.title = `${t} [${counters}]`;
  }
  panel.textContent = lines.join('\n');
}

function setDebugMode(on) {
  const panel = $('#debug-panel');
  clearInterval(debugTimer);
  debugTimer = null;
  panel.hidden = !on;
  if (on) {
    updateDebugPanel();
    debugTimer = setInterval(updateDebugPanel, 3000);
  } else {
    document.title = state.playing ? `${state.playing.title} — macca` : 'macca — ローカル音楽ライブラリ';
  }
  localStorage.setItem('macca-debug', on ? '1' : '0');
}

{
  const check = $('#debug-check');
  check.checked = localStorage.getItem('macca-debug') === '1';
  if (check.checked) setDebugMode(true);
  check.addEventListener('change', () => setDebugMode(check.checked));
}

// フォルダを固定ライブラリにする (⚙ フォルダ設定のフォルダ選択から呼ばれる)
async function pinPath(p) {
  deviceOpBusy = true;
  toast('スキャンしています…');
  try {
    const res = await fetch('/api/source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: p, pin: true }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? res.status);
    applyLibrary(json);
    toast('フォルダを固定ライブラリにしました');
  } catch (err) {
    toast(`固定に失敗しました: ${err.message}`);
  }
  deviceOpBusy = false;
  refreshDevices();
}

// フォルダブラウザ: /api/browse でデバイス配下だけを辿れる
const browseState = { path: null, parent: null };

async function openBrowse(p) {
  try {
    const res = await fetch(p ? `/api/browse?path=${encodeURIComponent(p)}` : '/api/browse');
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? res.status);
    browseState.path = json.path;
    browseState.parent = json.parent;
    $('#browse-path').textContent = json.path ?? 'デバイスを選択';
    $('#browse-up').disabled = !json.path;
    $('#browse-pin').disabled = !json.path;
    const list = $('#browse-list');
    list.innerHTML = json.dirs.length
      ? json.dirs.map((d) => `<button class="browse-item" data-path="${esc(d.path)}">📁 ${esc(d.name)}</button>`).join('')
      : '<div class="dev-empty">サブフォルダなし</div>';
    list.querySelectorAll('.browse-item').forEach((b) =>
      b.addEventListener('click', () => openBrowse(b.dataset.path)));
    const dlg = $('#browse-dialog');
    if (!dlg.open) dlg.showModal();
  } catch (err) {
    toast(`フォルダを開けませんでした: ${err.message}`);
  }
}

$('#browse-up').addEventListener('click', () => openBrowse(browseState.parent));
$('#browse-close').addEventListener('click', () => $('#browse-dialog').close());
$('#browse-pin').addEventListener('click', () => {
  $('#browse-dialog').close();
  if (browseState.path) pinPath(browseState.path);
});

// ---- 固定ライブラリの設定 (⚙) ----------------------------------------------
// どの場所を固定しているかの一覧・追加・解除

function renderPinnedList() {
  const list = $('#pinned-list');
  const pinned = (state.sources ?? []).filter((s) => s.pinned);
  list.innerHTML = pinned.length
    ? pinned.map((s) => `<div class="pinned-row">
        <div class="pinned-info">
          <div>💾 ${esc(s.label)} <span class="dev-count">${s.tracks} 曲</span></div>
          <div class="pinned-dir">${esc(s.dir)}</div>
        </div>
        <button class="dev-btn" data-unpin="${s.id}" title="固定をやめてライブラリから外す (ファイルには触れません)">解除</button>
      </div>`).join('')
    : '<div class="dev-empty">固定した場所はありません</div>';
  list.querySelectorAll('[data-unpin]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    deviceOpBusy = true;
    try {
      const res = await fetch(`/api/source/${b.dataset.unpin}`, { method: 'DELETE' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? res.status);
      applyLibrary(json);
      toast('固定を解除しました');
    } catch (err) {
      toast(`解除に失敗しました: ${err.message}`);
    }
    deviceOpBusy = false;
    renderPinnedList();
    refreshDevices();
  }));
}

$('#settings-btn').addEventListener('click', () => {
  renderPinnedList();
  $('#settings-dialog').showModal();
});
$('#settings-close').addEventListener('click', () => $('#settings-dialog').close());
$('#pinned-add').addEventListener('click', () => openBrowse(null));

// ---- 検索 / ナビゲーション ------------------------------------------------

let searchTimer = null;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.search = e.target.value.trim();
    state.renderLimit = 1000;
    render();
  }, 150);
});

document.querySelectorAll('.nav-item').forEach((b) => {
  b.addEventListener('click', () => {
    state.filterArtist = null;
    state.filterAlbum = null;
    setView(b.dataset.view);
  });
});

$('#rescan').addEventListener('click', async () => {
  $('#rescan').disabled = true;
  $('#rescan').textContent = 'スキャン中…';
  try {
    const res = await fetch('/api/rescan', { method: 'POST' });
    applyLibrary(await res.json());
    toast('再スキャン完了');
  } catch {
    toast('再スキャンに失敗しました');
  } finally {
    $('#rescan').disabled = false;
    $('#rescan').textContent = '再スキャン';
  }
});

// ---- 初期化 ---------------------------------------------------------------

// サーバが裏でスキャン中 (起動直後の固定ソース読み込み等) は
// 完了までライブラリを追いかけて、終わった分を画面に合流させる
let scanPollTimer = null;
function watchScanning(data) {
  if (!data.scanning || scanPollTimer) return;
  scanPollTimer = setInterval(async () => {
    try {
      const res = await fetch('/api/library');
      const json = await res.json();
      if (!json.scanning) {
        clearInterval(scanPollTimer);
        scanPollTimer = null;
      }
      applyLibrary(json);
    } catch {
      // サーバ再起動中など: 次の周期で再試行
    }
  }, 3000);
}

function applyLibrary(data) {
  state.tracks = data.tracks;
  state.ffmpeg = data.ffmpeg;
  state.dir = data.dir;
  state.sources = data.sources ?? [];
  watchScanning(data);
  // サーバ実装 (Go / JS) のバッジとバージョンを曲数の左に表示
  const badge = $('#impl-badge');
  if (data.server) {
    const isGo = data.server === 'go';
    badge.textContent = isGo ? 'Go' : 'JS';
    badge.className = `impl-badge ${isGo ? 'go' : 'js'}`;
    badge.title = `サーバ実装: ${isGo ? 'Go (シングルバイナリ)' : 'Node.js'}`;
    badge.hidden = false;
  }
  const ver = $('#impl-version');
  if (data.version) {
    ver.textContent = `v${String(data.version).replace(/^v/, '')}`;
    ver.hidden = false;
  }
  renderStats();
  renderFormatChips();
  renderDevices();
  if ($('#settings-dialog').open) renderPinnedList();
  render();
  if (data.errors > 0) toast(`${data.errors} 件のファイルが読み取れませんでした`);
}

(async function init() {
  const hashView = location.hash.replace('#', '');
  if (['songs', 'albums', 'artists'].includes(hashView)) state.view = hashView;
  try {
    const res = await fetch('/api/library');
    applyLibrary(await res.json());
    if (state.view !== 'songs') setView(state.view);
  } catch {
    $('#content').innerHTML = '<div class="loading">ライブラリの読み込みに失敗しました。サーバが起動しているか確認してください。</div>';
  }
  refreshDevices();
  setInterval(refreshDevices, 10000); // 抜き差しを 10 秒ごとに反映

  // ページが開いている間サーバに接続を張る (--exit-on-close 起動時、
  // 全ページが閉じられたらサーバが自動終了するための生存信号)
  if (typeof EventSource !== 'undefined') new EventSource('/api/presence');

  window.__macca = { engine, state }; // デバッグ・自動テスト用フック
})();
