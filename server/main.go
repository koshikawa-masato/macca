package server

import (
	"bytes"
	"context"
	"crypto/sha1"
	"embed"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	runtimedebug "runtime/debug"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

//go:embed all:static
var embeddedStatic embed.FS

var supportedExt = map[string]bool{
	".mp3": true, ".m4a": true, ".m4b": true, ".aac": true,
	".aif": true, ".aiff": true, ".aifc": true, ".flac": true,
	".wav": true, ".ogg": true, ".oga": true, ".opus": true,
}

var mimeByExt = map[string]string{
	".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".m4b": "audio/mp4", ".aac": "audio/aac",
	".aif": "audio/aiff", ".aiff": "audio/aiff", ".aifc": "audio/aiff", ".flac": "audio/flac",
	".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg; codecs=opus",
}

var staticTypes = map[string]string{
	".html": "text/html; charset=utf-8",
	".js":   "text/javascript; charset=utf-8",
	".css":  "text/css; charset=utf-8",
	".svg":  "image/svg+xml",
	".png":  "image/png",
	".ico":  "image/x-icon",
	".wasm": "application/wasm",
}

type nullableString = *string
type nullableInt = *int
type nullableFloat = *float64

type track struct {
	ID          string         `json:"id"`
	Src         string         `json:"src,omitempty"`
	Path        string         `json:"path"`
	Ext         string         `json:"ext"`
	Size        int64          `json:"size"`
	Title       string         `json:"title"`
	Artist      nullableString `json:"artist"`
	AlbumArtist nullableString `json:"albumArtist"`
	Album       nullableString `json:"album"`
	Genre       nullableString `json:"genre"`
	Year        nullableInt    `json:"year"`
	Track       nullableInt    `json:"track"`
	Duration    nullableFloat  `json:"duration"`
	Codec       nullableString `json:"codec"`
	Art         *artInfo       `json:"art,omitempty"`
}

type clientTrack struct {
	ID          string         `json:"id"`
	Src         string         `json:"src"`
	Path        string         `json:"path"`
	Ext         string         `json:"ext"`
	Size        int64          `json:"size"`
	Title       string         `json:"title"`
	Artist      nullableString `json:"artist"`
	AlbumArtist nullableString `json:"albumArtist"`
	Album       nullableString `json:"album"`
	Genre       nullableString `json:"genre"`
	Year        nullableInt    `json:"year"`
	Track       nullableInt    `json:"track"`
	Duration    nullableFloat  `json:"duration"`
	Codec       nullableString `json:"codec"`
	HasArt      bool           `json:"hasArt"`
}

type artInfo struct {
	Mime       string `json:"mime"`
	Offset     *int64 `json:"offset,omitempty"`
	Length     int64  `json:"length,omitempty"`
	DataBase64 string `json:"dataBase64,omitempty"`
}

// tags / metadataResult はスキャンキャッシュに JSON で保存される。
// Node 版 (~/.cache/macca) と相互運用できるよう、キー名を小文字に揃え
// 欠落値はキーごと省略する (Node は存在するタグだけを書く)。
type tags struct {
	Title       string `json:"title,omitempty"`
	Artist      string `json:"artist,omitempty"`
	AlbumArtist string `json:"albumArtist,omitempty"`
	Album       string `json:"album,omitempty"`
	Genre       string `json:"genre,omitempty"`
	Year        *int   `json:"year,omitempty"`
	Track       *int   `json:"track,omitempty"`
}

type metadataResult struct {
	Tags     tags     `json:"tags"`
	Duration *float64 `json:"duration,omitempty"`
	Codec    string   `json:"codec,omitempty"`
	Art      *artInfo `json:"art,omitempty"`
}

type source struct {
	ID        string
	Dir       string
	Label     string
	Removable bool
	Tracks    []track
	Errors    []scanError
}

type scanError struct {
	Path  string `json:"path"`
	Error string `json:"error"`
}

type librarySource struct {
	ID        string `json:"id"`
	Dir       string `json:"dir"`
	Label     string `json:"label"`
	Removable bool   `json:"removable"`
	Tracks    int    `json:"tracks"`
	Errors    int    `json:"errors"`
}

type libraryResponse struct {
	Dir       string          `json:"dir"`
	Server    string          `json:"server"`  // サーバ実装の識別 (UI のバッジ表示用)
	Version   string          `json:"version"` // アプリのバージョン (UI 表示用)
	Sources   []librarySource `json:"sources"`
	ScannedAt string          `json:"scannedAt"`
	Scanning  bool            `json:"scanning"`
	Ffmpeg    bool            `json:"ffmpeg"`
	Errors    int             `json:"errors"`
	Tracks    []clientTrack   `json:"tracks"`
}

type appState struct {
	mu          sync.RWMutex
	rootDir     string
	publicDir   string
	sources     map[string]*source
	tracks      []track
	byID        map[string]track
	scanning    bool
	scannedAt   string
	ffmpeg      bool
	folderArt   map[string]string
	exitOnClose bool

	presenceMu    sync.Mutex
	presenceCount int
	presenceTimer *time.Timer

	statsMu    sync.Mutex
	statsCPU   time.Duration
	statsAt    time.Time
}

type options struct {
	dir         string
	port        string
	host        string
	cache       bool
	open        bool
	exitOnClose bool
	publicDir   string
	sources     []string
}

type stringList []string

func (s *stringList) String() string { return strings.Join(*s, ",") }
func (s *stringList) Set(v string) error {
	*s = append(*s, v)
	return nil
}

// Main は macca サーバのエントリポイント (cmd/macca から呼ばれる)
func Main() {
	opts := parseArgs(os.Args[1:])
	if opts.dir == "" {
		dir, err := findDefaultLibrary()
		if err != nil {
			fmt.Fprintln(os.Stderr, "エラー: iTunes / ミュージックのライブラリが見つかりませんでした。")
			fmt.Fprintln(os.Stderr, "使い方: macca <音楽ディレクトリ> [--port 8323]")
			os.Exit(1)
		}
		opts.dir = dir
		fmt.Printf("ディレクトリ未指定のため自動検出: %s\n", dir)
	}
	st, err := os.Stat(opts.dir)
	if err != nil || !st.IsDir() {
		fmt.Fprintf(os.Stderr, "エラー: ディレクトリが見つかりません: %s\n", opts.dir)
		fmt.Fprintln(os.Stderr, "使い方: macca <音楽ディレクトリ> [--port 8323]")
		os.Exit(1)
	}

	state, err := newState(opts)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	server := &http.Server{Handler: state.routes(opts.cache)}
	ln, err := net.Listen("tcp", net.JoinHostPort(opts.host, opts.port))
	// ランチャー起動 (--exit-on-close) では重複起動を許す:
	// ポートが使用中なら次のポートへずらして新しいインスタンスを立てる
	if err != nil && opts.exitOnClose {
		if base, perr := strconv.Atoi(opts.port); perr == nil {
			for i := 1; i <= 20 && err != nil; i++ {
				ln, err = net.Listen("tcp", net.JoinHostPort(opts.host, strconv.Itoa(base+i)))
			}
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	actualPort := ln.Addr().(*net.TCPAddr).Port
	urlHost := opts.host
	if urlHost == "0.0.0.0" || urlHost == "" {
		urlHost = "127.0.0.1"
	}
	url := fmt.Sprintf("http://%s:%d/", urlHost, actualPort)
	fmt.Println("")
	fmt.Printf("  macca 起動: %s\n", url)
	fmt.Printf("  ライブラリ: %s\n", state.rootDir)
	if state.ffmpeg {
		fmt.Println("  ffmpeg: あり (非対応形式は WAV に変換して再生)")
	} else {
		fmt.Println("  ffmpeg: なし (Safari 以外では ALAC/AIFF が再生できない場合があります)")
	}
	fmt.Println("")
	if opts.open {
		openBrowser(url)
	}
	if err := server.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func parseArgs(args []string) options {
	opts := options{port: "8323", host: "127.0.0.1", cache: true}
	usage := func() {
		fmt.Println("使い方: macca [音楽ディレクトリ] [--port 8323] [--host 127.0.0.1] [--source <dir>]... [--no-cache] [--open] [--exit-on-close] [--public <dir>] [--help]")
		fmt.Println("ディレクトリを省略すると iTunes / ミュージックのライブラリを自動検出します。")
	}
	for i := 0; i < len(args); i++ {
		a := args[i]
		switch a {
		case "--port":
			i++
			if i < len(args) {
				opts.port = args[i]
			}
		case "--host":
			i++
			if i < len(args) {
				opts.host = args[i]
			}
		case "--source":
			i++
			if i < len(args) {
				opts.sources = append(opts.sources, args[i])
			}
		case "--public":
			i++
			if i < len(args) {
				opts.publicDir = args[i]
			}
		case "--no-cache":
			opts.cache = false
		case "--open":
			opts.open = true
		case "--exit-on-close":
			opts.exitOnClose = true
		case "--help", "-h":
			usage()
			os.Exit(0)
		default:
			if !strings.HasPrefix(a, "-") && opts.dir == "" {
				opts.dir = a
			}
		}
	}
	return opts
}

func newState(opts options) (*appState, error) {
	root, err := filepath.Abs(opts.dir)
	if err != nil {
		return nil, err
	}
	state := &appState{
		rootDir:     root,
		publicDir:   resolvePublicDir(opts.publicDir),
		sources:     map[string]*source{},
		byID:        map[string]track{},
		ffmpeg:      hasCommand("ffmpeg"),
		folderArt:   map[string]string{},
		exitOnClose: opts.exitOnClose,
	}
	primary := &source{ID: sourceID(root), Dir: root, Label: "ライブラリ", Removable: false}
	state.sources[primary.ID] = primary
	for _, dir := range opts.sources {
		resolved, err := filepath.Abs(dir)
		if err != nil {
			return nil, err
		}
		id := sourceID(resolved)
		if _, ok := state.sources[id]; ok {
			continue
		}
		label := filepath.Base(resolved)
		if label == "." || label == string(filepath.Separator) {
			label = resolved
		}
		state.sources[id] = &source{ID: id, Dir: resolved, Label: label, Removable: false}
	}
	if err := state.rescan(opts.cache); err != nil {
		return nil, err
	}
	go state.keepRemovableAwake()
	return state, nil
}

// リムーバブルソース (SD カード等) を使用中はスリープさせない。
// macOS 等は無アクセスが続く外部ディスクを止めるため、次の曲の再生開始が
// ドライブの起床待ち (数秒) になる。5 分ごとに数 KB 読んで防ぐ。
func (s *appState) keepRemovableAwake() {
	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()
	buf := make([]byte, 4096)
	for range ticker.C {
		s.mu.RLock()
		var paths []string
		for _, src := range s.sources {
			if src.Removable && len(src.Tracks) > 0 {
				paths = append(paths, filepath.Join(src.Dir, src.Tracks[0].Path))
			}
		}
		s.mu.RUnlock()
		for _, p := range paths {
			if f, err := os.Open(p); err == nil {
				_, _ = f.Read(buf)
				_ = f.Close()
			}
		}
	}
}

func resolvePublicDir(flagValue string) string {
	if flagValue != "" {
		if p, err := filepath.Abs(flagValue); err == nil {
			return p
		}
		return flagValue
	}
	// 開発時: リポジトリ直下で実行しているならディスク上のフロントを配信
	// (embed 済みでも、フロント編集を再ビルドなしで反映できるように)
	if p, err := filepath.Abs(filepath.Join("server", "static", "public")); err == nil {
		if st, statErr := os.Stat(p); statErr == nil && st.IsDir() {
			return p
		}
	}
	return ""
}

func (s *appState) routes(useCache bool) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			s.serveAPI(w, r, useCache)
			return
		}
		rel := strings.TrimPrefix(r.URL.Path, "/")
		if rel == "" {
			rel = "index.html"
		}
		// Localize は ".." を含む非ローカルパスを拒否する (パストラバーサル対策)
		p, err := filepath.Localize(rel)
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		s.serveStatic(w, r, filepath.Clean(p))
	})
	return mux
}

func (s *appState) serveAPI(w http.ResponseWriter, r *http.Request, useCache bool) {
	p := r.URL.Path
	switch {
	case p == "/api/library" && r.Method == http.MethodGet:
		s.serveLibrary(w)
	case p == "/api/rescan" && r.Method == http.MethodPost:
		_ = s.rescan(useCache)
		s.serveLibrary(w)
	case p == "/api/presence" && r.Method == http.MethodGet:
		s.servePresence(w, r)
	case p == "/api/stats" && r.Method == http.MethodGet:
		s.serveStats(w)
	case p == "/api/devices" && r.Method == http.MethodGet:
		s.serveDevices(w)
	case p == "/api/source" && r.Method == http.MethodPost:
		s.addDeviceSource(w, r, useCache)
	case strings.HasPrefix(p, "/api/source/") && r.Method == http.MethodDelete:
		id := strings.TrimPrefix(p, "/api/source/")
		if len(id) != 12 {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		s.removeDeviceSource(w, id)
	case strings.HasPrefix(p, "/api/stream/") && (r.Method == http.MethodGet || r.Method == http.MethodHead):
		id := strings.TrimPrefix(p, "/api/stream/")
		s.serveStream(w, r, id)
	case strings.HasPrefix(p, "/api/artwork/") && r.Method == http.MethodGet:
		id := strings.TrimPrefix(p, "/api/artwork/")
		s.serveArtwork(w, r, id)
	default:
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
	}
}

func (s *appState) serveStatic(w http.ResponseWriter, r *http.Request, rel string) {
	if rel == "." || rel == string(filepath.Separator) {
		rel = "index.html"
	}
	if strings.HasPrefix(rel, ".."+string(filepath.Separator)) || rel == ".." || filepath.IsAbs(rel) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if s.publicDir != "" {
		base := filepath.Clean(s.publicDir)
		full := filepath.Clean(filepath.Join(base, rel))
		if full != base && !strings.HasPrefix(full, base+string(filepath.Separator)) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		data, err := os.ReadFile(full)
		if err == nil {
			writeStatic(w, filepath.Ext(full), data)
			return
		}
	}
	embedPath := filepath.ToSlash(filepath.Join("static", "public", rel))
	if data, err := fs.ReadFile(embeddedStatic, embedPath); err == nil {
		writeStatic(w, filepath.Ext(rel), data)
		return
	}
	if rel != "index.html" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	data, err := fs.ReadFile(embeddedStatic, "static/index.html")
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	writeStatic(w, ".html", data)
}

func writeStatic(w http.ResponseWriter, ext string, data []byte) {
	ct := staticTypes[strings.ToLower(ext)]
	if ct == "" {
		ct = mime.TypeByExtension(ext)
	}
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}

func (s *appState) serveLibrary(w http.ResponseWriter) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	sources := make([]librarySource, 0, len(s.sources))
	totalErrors := 0
	ids := make([]string, 0, len(s.sources))
	for id := range s.sources {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		src := s.sources[id]
		errs := len(src.Errors)
		totalErrors += errs
		sources = append(sources, librarySource{
			ID: src.ID, Dir: src.Dir, Label: src.Label, Removable: src.Removable,
			Tracks: len(src.Tracks), Errors: errs,
		})
	}
	outTracks := make([]clientTrack, 0, len(s.tracks))
	for _, t := range s.tracks {
		outTracks = append(outTracks, clientTrack{
			ID: t.ID, Src: t.Src, Path: t.Path, Ext: t.Ext, Size: t.Size, Title: t.Title,
			Artist: t.Artist, AlbumArtist: t.AlbumArtist, Album: t.Album, Genre: t.Genre,
			Year: t.Year, Track: t.Track, Duration: t.Duration, Codec: t.Codec,
			HasArt: t.Art != nil,
		})
	}
	writeJSON(w, http.StatusOK, libraryResponse{
		Dir: s.rootDir, Server: "go", Version: Version, Sources: sources, ScannedAt: s.scannedAt,
		Scanning: s.scanning, Ffmpeg: s.ffmpeg, Errors: totalErrors, Tracks: outTracks,
	})
}

func (s *appState) rescan(useCache bool) error {
	s.mu.Lock()
	if s.scanning {
		s.mu.Unlock()
		return nil
	}
	s.scanning = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.scanning = false
		s.mu.Unlock()
	}()

	s.mu.RLock()
	sources := make([]*source, 0, len(s.sources))
	for _, src := range s.sources {
		sources = append(sources, src)
	}
	s.mu.RUnlock()

	for _, src := range sources {
		tracks, errs := scanLibrary(src.Dir, useCache && !src.Removable)
		s.mu.Lock()
		src.Tracks = tracks
		for i := range src.Tracks {
			src.Tracks[i].Src = src.ID
		}
		src.Errors = errs
		s.mu.Unlock()
	}
	s.rebuildIndex()
	// スキャン中の一時確保 (タグ読み) を OS に返して待機時 RSS を抑える
	runtimedebug.FreeOSMemory()
	return nil
}

func (s *appState) rebuildIndex() {
	s.mu.Lock()
	defer s.mu.Unlock()
	var all []track
	s.byID = map[string]track{}
	for _, src := range s.sources {
		all = append(all, src.Tracks...)
	}
	sortTracks(all)
	for _, t := range all {
		s.byID[t.ID] = t
	}
	s.tracks = all
	s.scannedAt = time.Now().UTC().Format(time.RFC3339Nano)
	s.folderArt = map[string]string{}
}

func sortTracks(tracks []track) {
	sort.SliceStable(tracks, func(i, j int) bool {
		a, b := tracks[i], tracks[j]
		if cmp := strings.Compare(value(a.Artist), value(b.Artist)); cmp != 0 {
			return cmp < 0
		}
		if cmp := strings.Compare(value(a.Album), value(b.Album)); cmp != 0 {
			return cmp < 0
		}
		ta, tb := 9999, 9999
		if a.Track != nil {
			ta = *a.Track
		}
		if b.Track != nil {
			tb = *b.Track
		}
		if ta != tb {
			return ta < tb
		}
		return strings.Compare(a.Title, b.Title) < 0
	})
}

func scanLibrary(rootDir string, useCache bool) ([]track, []scanError) {
	cache := map[string]cacheEntry{}
	if useCache {
		cache = loadCache(rootDir)
	}
	newCache := map[string]cacheEntry{}
	var cacheMu sync.Mutex
	var paths []string
	_ = filepath.WalkDir(rootDir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.Name() != "." && strings.HasPrefix(d.Name(), ".") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.Type().IsRegular() && supportedExt[strings.ToLower(filepath.Ext(d.Name()))] {
			paths = append(paths, p)
		}
		return nil
	})
	sort.Strings(paths)

	type job struct {
		path string
	}
	jobs := make(chan job)
	results := make(chan struct {
		track track
		err   scanError
		ok    bool
	}, len(paths))
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range jobs {
				rel, _ := filepath.Rel(rootDir, j.path)
				st, err := os.Stat(j.path)
				if err != nil {
					results <- struct {
						track track
						err   scanError
						ok    bool
					}{err: scanError{Path: rel, Error: err.Error()}}
					continue
				}
				// Node の stats.mtimeMs (sec*1000 + nsec/1e6 の double) とビット一致させる。
				// UnixNano() は float64 の仮数を超えて丸めが入るため使わない
				mt := st.ModTime()
				mtimeMs := float64(mt.Unix())*1000 + float64(mt.Nanosecond())/1e6
				var meta metadataResult
				if c, ok := cache[rel]; ok && c.MtimeMs == mtimeMs && c.Size == st.Size() {
					meta = c.Meta
				} else {
					meta = readMetadata(j.path, st.Size())
				}
				cacheMu.Lock()
				newCache[rel] = cacheEntry{MtimeMs: mtimeMs, Size: st.Size(), Meta: meta}
				cacheMu.Unlock()
				ext := strings.ToLower(filepath.Ext(j.path))
				title := meta.Tags.Title
				if title == "" {
					fb := fallbackFromFilename(j.path)
					title = fb.Title
					if meta.Tags.Artist == "" {
						meta.Tags.Artist = fb.Artist
					}
				}
				t := track{
					ID: trackID(rootDir, rel), Path: rel, Ext: ext, Size: st.Size(), Title: title,
					Artist: strPtr(meta.Tags.Artist), AlbumArtist: strPtr(meta.Tags.AlbumArtist),
					Album: strPtr(meta.Tags.Album), Genre: strPtr(meta.Tags.Genre),
					Year: meta.Tags.Year, Track: meta.Tags.Track, Duration: meta.Duration,
					Codec: strPtr(meta.Codec), Art: meta.Art,
				}
				results <- struct {
					track track
					err   scanError
					ok    bool
				}{track: t, ok: true}
			}
		}()
	}
	go func() {
		for _, p := range paths {
			jobs <- job{path: p}
		}
		close(jobs)
		wg.Wait()
		close(results)
	}()

	var tracks []track
	var errs []scanError
	for r := range results {
		if r.ok {
			tracks = append(tracks, r.track)
		} else {
			errs = append(errs, r.err)
		}
	}
	if useCache {
		saveCache(rootDir, newCache)
	}
	sortTracks(tracks)
	return tracks, errs
}

type cacheEntry struct {
	MtimeMs float64        `json:"mtimeMs"`
	Size    int64          `json:"size"`
	Meta    metadataResult `json:"meta"`
}

type cacheFile struct {
	Version int                   `json:"version"`
	Files   map[string]cacheEntry `json:"files"`
}

func cacheFileFor(rootDir string) string {
	sum := sha1.Sum([]byte(absPath(rootDir)))
	return filepath.Join(cacheDir(), "library-"+fmt.Sprintf("%x", sum)[:12]+".json")
}

func cacheDir() string {
	// Node 版と同じ ~/.cache/macca に固定する (OS 慣習より相互運用を優先)
	if home, err := os.UserHomeDir(); err == nil {
		return filepath.Join(home, ".cache", "macca")
	}
	return filepath.Join(os.TempDir(), "macca")
}

func loadCache(rootDir string) map[string]cacheEntry {
	data, err := os.ReadFile(cacheFileFor(rootDir))
	if err != nil {
		return map[string]cacheEntry{}
	}
	var cf cacheFile
	if json.Unmarshal(data, &cf) != nil || cf.Version != 1 || cf.Files == nil {
		return map[string]cacheEntry{}
	}
	return cf.Files
}

func saveCache(rootDir string, files map[string]cacheEntry) {
	_ = os.MkdirAll(cacheDir(), 0o755)
	data, err := json.Marshal(cacheFile{Version: 1, Files: files})
	if err == nil {
		_ = os.WriteFile(cacheFileFor(rootDir), data, 0o644)
	}
}

func readMetadata(filePath string, fileSize int64) metadataResult {
	ext := strings.ToLower(filepath.Ext(filePath))
	f, err := os.Open(filePath)
	if err != nil {
		return metadataResult{}
	}
	defer f.Close()
	var r metadataResult
	switch ext {
	case ".mp3", ".aac":
		r = parseMP3(f, fileSize)
	case ".m4a", ".m4b":
		r = parseMP4(f, fileSize)
	case ".flac":
		r = parseFLAC(f, fileSize)
	case ".aif", ".aiff", ".aifc":
		r = parseAIFF(f, fileSize)
	case ".wav":
		r = parseWAV(f, fileSize)
	default:
		r = metadataResult{}
	}
	if r.Tags.Title == "" {
		fb := fallbackFromFilename(filePath)
		if fb.Title != "" {
			r.Tags.Title = fb.Title
		}
		if r.Tags.Artist == "" {
			r.Tags.Artist = fb.Artist
		}
	}
	return r
}

func parseMP3(f *os.File, fileSize int64) metadataResult {
	head := readAt(f, 0, 10)
	audioStart := int64(0)
	r := metadataResult{Codec: "mp3"}
	if len(head) == 10 && string(head[:3]) == "ID3" {
		tagSize := int64(10 + syncsafe(head[6:10]))
		body := readAt(f, 0, min64(tagSize, 16*1024*1024))
		parsed := parseID3(body, 0)
		r.Tags = parsed.Tags
		r.Art = parsed.Art
		audioStart = tagSize
	}
	frame := readAt(f, audioStart, 64*1024)
	if d := estimateMP3Duration(frame, fileSize-audioStart); d > 0 {
		r.Duration = &d
	}
	return r
}

var mp3BitratesV1L3 = []int{0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320}
var mp3BitratesV2L3 = []int{0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160}

// MP3 の再生時間推定 (lib/mp3.js と同一)。
// Xing/Info ヘッダ (VBR) があればフレーム数から正確に、なければ CBR とみなす。
func estimateMP3Duration(buf []byte, audioSize int64) float64 {
	for i := 0; i+4 <= len(buf); i++ {
		if buf[i] != 0xff || buf[i+1]&0xe0 != 0xe0 {
			continue
		}
		version := (buf[i+1] >> 3) & 0x03 // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
		layer := (buf[i+1] >> 1) & 0x03   // 1=Layer3
		bitrateIdx := (buf[i+2] >> 4) & 0x0f
		srIdx := (buf[i+2] >> 2) & 0x03
		if version == 1 || layer != 1 || bitrateIdx == 0 || bitrateIdx == 15 || srIdx == 3 {
			continue
		}
		var sampleRate int
		switch version {
		case 3:
			sampleRate = []int{44100, 48000, 32000}[srIdx]
		case 2:
			sampleRate = []int{22050, 24000, 16000}[srIdx]
		case 0:
			sampleRate = []int{11025, 12000, 8000}[srIdx]
		}
		var bitrate int
		samplesPerFrame := 576
		if version == 3 {
			bitrate = mp3BitratesV1L3[bitrateIdx] * 1000
			samplesPerFrame = 1152
		} else {
			bitrate = mp3BitratesV2L3[bitrateIdx] * 1000
		}

		// Xing/Info ヘッダ (サイド情報の直後に置かれる)
		channelMode := (buf[i+3] >> 6) & 0x03
		sideInfo := 17
		if version == 3 {
			if channelMode != 3 {
				sideInfo = 32
			}
		} else {
			if channelMode == 3 {
				sideInfo = 9
			}
		}
		xingPos := i + 4 + sideInfo
		if xingPos+8 <= len(buf) {
			tag := string(buf[xingPos : xingPos+4])
			if tag == "Xing" || tag == "Info" {
				flags := binary.BigEndian.Uint32(buf[xingPos+4 : xingPos+8])
				if flags&0x01 != 0 && xingPos+12 <= len(buf) {
					frames := binary.BigEndian.Uint32(buf[xingPos+8 : xingPos+12])
					return float64(frames) * float64(samplesPerFrame) / float64(sampleRate)
				}
			}
		}
		// CBR とみなす
		if bitrate > 0 {
			return float64(audioSize*8) / float64(bitrate)
		}
		return 0
	}
	return 0
}

// lib/id3.js の TEXT_FRAMES と同一 (v2.3/2.4 の 4 文字 ID + v2.2 の 3 文字 ID)
var id3TextFrames = map[string]string{
	"TIT2": "title", "TPE1": "artist", "TPE2": "albumArtist", "TALB": "album",
	"TCON": "genre", "TRCK": "track", "TYER": "year", "TDRC": "year",
	"TT2": "title", "TP1": "artist", "TP2": "albumArtist", "TAL": "album",
	"TCO": "genre", "TRK": "track", "TYE": "year",
}

/* 0xFF 0x00 → 0xFF の unsynchronisation を戻す */
func deUnsync(b []byte) []byte {
	out := make([]byte, 0, len(b))
	for i := 0; i < len(b); i++ {
		out = append(out, b[i])
		if b[i] == 0xff && i+1 < len(b) && b[i+1] == 0x00 {
			i++
		}
	}
	return out
}

func isFrameID(id string) bool {
	if id == "" {
		return false
	}
	for _, c := range id {
		if !((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')) {
			return false
		}
	}
	return true
}

/* エンコーディングに応じた NUL 終端位置を探し、終端直後のオフセットを返す */
func skipTerminatedString(data []byte, start int, encodingByte byte) int {
	if encodingByte == 1 || encodingByte == 2 { // UTF-16: 2 バイト単位の 0x0000
		for i := start; i+1 < len(data); i += 2 {
			if data[i] == 0 && data[i+1] == 0 {
				return i + 2
			}
		}
		return len(data)
	}
	if start >= len(data) {
		return len(data)
	}
	idx := bytes.IndexByte(data[start:], 0)
	if idx == -1 {
		return len(data)
	}
	return start + idx + 1
}

// ID3v2 (v2.2 / v2.3 / v2.4) タグをパースする。lib/id3.js の parseId3 と同一挙動。
func parseID3(buf []byte, fileOffset int64) metadataResult {
	var r metadataResult
	if len(buf) < 10 || string(buf[:3]) != "ID3" {
		return r
	}
	major := int(buf[3])
	flags := buf[5]
	tagSize := syncsafe(buf[6:10])
	tagEnd := min(len(buf), 10+tagSize)

	body := buf[10:tagEnd]
	unsyncedGlobally := false
	if flags&0x80 != 0 && major < 4 { // v2.4 は通常フレーム単位
		body = deUnsync(body)
		unsyncedGlobally = true
	}

	pos := 0
	// 拡張ヘッダをスキップ
	if flags&0x40 != 0 && len(body) >= 4 {
		if major == 3 {
			pos = 4 + int(binary.BigEndian.Uint32(body[:4]))
		} else if major == 4 {
			pos = syncsafe(body[:4])
		}
	}

	rawTags := map[string]string{}
	idLen, hdrLen := 4, 10
	if major == 2 {
		idLen, hdrLen = 3, 6
	}

	for pos >= 0 && pos+hdrLen <= len(body) {
		if body[pos] == 0 { // パディング領域
			break
		}
		id := string(body[pos : pos+idLen])
		if !isFrameID(id) {
			break
		}
		var size int
		frameFlags := 0
		if major == 2 {
			size = int(body[pos+3])<<16 | int(body[pos+4])<<8 | int(body[pos+5])
		} else {
			if major == 4 {
				size = syncsafe(body[pos+idLen : pos+idLen+4])
			} else {
				size = int(binary.BigEndian.Uint32(body[pos+idLen : pos+idLen+4]))
			}
			frameFlags = int(binary.BigEndian.Uint16(body[pos+idLen+4 : pos+idLen+6]))
		}
		dataStart := pos + hdrLen
		if size < 0 || dataStart+size > len(body) {
			break
		}
		data := body[dataStart : dataStart+size]
		pos = dataStart + size

		// 圧縮・暗号化フレームは扱わない
		if major == 3 && frameFlags&0x00c0 != 0 {
			continue
		}
		if major == 4 && frameFlags&0x000c != 0 {
			continue
		}

		frameUnsynced := false
		skippedDLI := 0
		if major == 4 && frameFlags&0x0002 != 0 {
			data = deUnsync(data)
			frameUnsynced = true
		}
		if major == 4 && frameFlags&0x0001 != 0 { // data length indicator
			if len(data) >= 4 {
				data = data[4:]
			} else {
				data = nil
			}
			skippedDLI = 4
		}

		if field, ok := id3TextFrames[id]; ok && len(data) >= 1 {
			value := decodeID3Text(data[0], data[1:])
			if value != "" {
				if _, exists := rawTags[field]; !exists {
					if field == "genre" {
						value = resolveGenre(value)
					}
					rawTags[field] = value
				}
			}
			continue
		}

		if (id == "APIC" || id == "PIC") && len(data) > 4 && r.Art == nil {
			enc := data[0]
			var p int
			var mimeType string
			if id == "PIC" { // v2.2: 画像フォーマット 3 文字
				if strings.EqualFold(string(data[1:4]), "png") {
					mimeType = "image/png"
				} else {
					mimeType = "image/jpeg"
				}
				p = 4
			} else {
				mimeEnd := bytes.IndexByte(data[1:], 0)
				if mimeEnd < 0 {
					continue
				}
				mimeType = string(data[1 : 1+mimeEnd])
				if mimeType == "" {
					mimeType = "image/jpeg"
				}
				p = 1 + mimeEnd + 1
			}
			p++ // picture type
			p = skipTerminatedString(data, p, enc) // description
			if p >= len(data) {
				continue
			}
			if unsyncedGlobally || frameUnsynced {
				// unsync 解除でファイル内オフセットがずれるため画像バイト列自体を保持
				r.Art = &artInfo{Mime: mimeType, DataBase64: base64.StdEncoding.EncodeToString(data[p:])}
			} else {
				offset := fileOffset + 10 + int64(dataStart) + int64(skippedDLI) + int64(p)
				r.Art = &artInfo{Mime: mimeType, Offset: &offset, Length: int64(len(data) - p)}
			}
		}
	}

	r.Tags.Title = rawTags["title"]
	r.Tags.Artist = rawTags["artist"]
	r.Tags.AlbumArtist = rawTags["albumArtist"]
	r.Tags.Album = rawTags["album"]
	r.Tags.Genre = rawTags["genre"]
	if v, ok := rawTags["track"]; ok {
		r.Tags.Track = parseLeadingInt(v)
	}
	if v, ok := rawTags["year"]; ok {
		r.Tags.Year = parseYear(v)
	}
	return r
}

// ID3v2 のエンコーディングバイト付きテキストのデコード (lib/util.js decodeId3Text と同一)
func decodeID3Text(enc byte, raw []byte) string {
	var s string
	switch enc {
	case 1: // UTF-16 with BOM
		if len(raw) >= 2 && raw[0] == 0xfe && raw[1] == 0xff {
			s = decodeUTF16Strict(raw[2:], true)
		} else {
			body := raw
			if len(raw) >= 2 && raw[0] == 0xff && raw[1] == 0xfe {
				body = raw[2:]
			}
			s = decodeUTF16Strict(body, false)
		}
	case 2: // UTF-16BE without BOM
		s = decodeUTF16Strict(raw, true)
	case 3: // UTF-8
		if utf8.Valid(raw) {
			s = string(raw)
		} else {
			s = decodeLoose(raw)
		}
	default: // 0: 仕様上は ISO-8859-1 だが実態に合わせて緩く解釈
		s = decodeLoose(raw)
	}
	// 終端 NUL と前後空白を除去し、複数値は先頭のみ採用
	s = strings.TrimRight(s, "\x00")
	if i := strings.IndexByte(s, 0); i >= 0 {
		s = s[:i]
	}
	return strings.TrimSpace(s)
}

// エンコーディング宣言が当てにならないタグ文字列のデコード。
// ASCII → そのまま / UTF-8 → Shift_JIS → Latin-1 の順に試す (lib/util.js decodeLoose)。
func decodeLoose(raw []byte) string {
	if len(raw) == 0 {
		return ""
	}
	ascii := true
	for _, b := range raw {
		if b >= 0x80 {
			ascii = false
			break
		}
	}
	if ascii {
		return string(raw)
	}
	if utf8.Valid(raw) {
		return string(raw)
	}
	if s, ok := decodeShiftJIS(raw); ok {
		return s
	}
	runes := make([]rune, len(raw))
	for i, b := range raw {
		runes[i] = rune(b)
	}
	return string(runes)
}

// Shift_JIS (CP932) の厳密デコード。不正なバイト列は ok=false。
// テーブルは build/gen-sjis/gen.mjs が Node の TextDecoder から生成 (sjis.go)。
func decodeShiftJIS(raw []byte) (string, bool) {
	var sb strings.Builder
	for i := 0; i < len(raw); {
		b := raw[i]
		if r, ok := sjisSingle[b]; ok {
			sb.WriteRune(r)
			i++
			continue
		}
		if i+1 < len(raw) {
			if r, ok := sjisDouble[uint16(b)<<8|uint16(raw[i+1])]; ok {
				sb.WriteRune(r)
				i += 2
				continue
			}
		}
		return "", false
	}
	return sb.String(), true
}

// UTF-16 の厳密デコード (TextDecoder の fatal 相当: 奇数長・不正サロゲートは空文字)
func decodeUTF16Strict(raw []byte, be bool) string {
	if len(raw)%2 != 0 {
		return ""
	}
	u := make([]uint16, 0, len(raw)/2)
	for i := 0; i+1 < len(raw); i += 2 {
		if be {
			u = append(u, binary.BigEndian.Uint16(raw[i:i+2]))
		} else {
			u = append(u, binary.LittleEndian.Uint16(raw[i:i+2]))
		}
	}
	for i := 0; i < len(u); i++ {
		c := u[i]
		if c >= 0xd800 && c < 0xdc00 {
			if i+1 >= len(u) || u[i+1] < 0xdc00 || u[i+1] > 0xdfff {
				return ""
			}
			i++
		} else if c >= 0xdc00 && c <= 0xdfff {
			return ""
		}
	}
	return string(utf16.Decode(u))
}

func parseWAV(f *os.File, fileSize int64) metadataResult {
	head := readAt(f, 0, 12)
	if len(head) < 12 || string(head[:4]) != "RIFF" || string(head[8:12]) != "WAVE" {
		return metadataResult{}
	}
	r := metadataResult{Codec: "pcm"}
	var byteRate uint32
	var dataSize uint32
	for pos := int64(12); pos+8 <= fileSize; {
		ch := readAt(f, pos, 8)
		if len(ch) < 8 {
			break
		}
		id := string(ch[:4])
		size := binary.LittleEndian.Uint32(ch[4:8])
		dataPos := pos + 8
		switch {
		case id == "fmt " && size >= 16:
			b := readAt(f, dataPos, 16)
			if len(b) >= 12 {
				byteRate = binary.LittleEndian.Uint32(b[8:12])
			}
		case id == "data":
			dataSize = size
		case id == "LIST" && size >= 4 && size <= 64*1024*1024:
			b := readAt(f, dataPos, int64(size))
			parseWAVInfo(b, &r.Tags)
		case (id == "id3 " || id == "ID3 ") && size > 10 && size <= 64*1024*1024:
			parsed := parseID3(readAt(f, dataPos, int64(size)), dataPos)
			mergeTags(&r.Tags, parsed.Tags)
			if r.Art == nil {
				r.Art = parsed.Art
			}
		}
		pos = dataPos + int64(size) + int64(size%2)
	}
	if byteRate > 0 && dataSize > 0 {
		d := float64(dataSize) / float64(byteRate)
		r.Duration = &d
	}
	return r
}

func parseWAVInfo(b []byte, t *tags) {
	if len(b) < 4 || string(b[:4]) != "INFO" {
		return
	}
	for p := 4; p+8 <= len(b); {
		id := string(b[p : p+4])
		size := int(binary.LittleEndian.Uint32(b[p+4 : p+8]))
		if size < 0 || p+8+size > len(b) {
			break
		}
		raw := b[p+8 : p+8+size]
		if i := bytes.IndexByte(raw, 0); i >= 0 { // 最初の NUL で切る (Node と同一)
			raw = raw[:i]
		}
		val := strings.TrimSpace(decodeLoose(raw))
		switch id {
		case "INAM":
			t.Title = val
		case "IART":
			t.Artist = val
		case "IPRD":
			t.Album = val
		case "IGNR":
			t.Genre = val
		case "ICRD":
			t.Year = parseYear(val)
		}
		p += 8 + size + size%2
	}
}

func parseAIFF(f *os.File, fileSize int64) metadataResult {
	head := readAt(f, 0, 12)
	if len(head) < 12 || string(head[:4]) != "FORM" || string(head[8:12]) != "AIFF" {
		return metadataResult{}
	}
	r := metadataResult{Codec: "aiff"}
	for pos := int64(12); pos+8 <= fileSize; {
		ch := readAt(f, pos, 8)
		if len(ch) < 8 {
			break
		}
		id := string(ch[:4])
		size := binary.BigEndian.Uint32(ch[4:8])
		dataPos := pos + 8
		switch {
		case id == "COMM" && size >= 18:
			b := readAt(f, dataPos, 18)
			frames := binary.BigEndian.Uint32(b[2:6])
			rate := readExt80(b[8:18])
			if rate > 0 {
				d := float64(frames) / rate
				r.Duration = &d
			}
		case id == "ID3 " && size > 10 && size <= 64*1024*1024:
			parsed := parseID3(readAt(f, dataPos, int64(size)), dataPos)
			mergeTags(&r.Tags, parsed.Tags)
			if r.Art == nil {
				r.Art = parsed.Art
			}
		}
		pos = dataPos + int64(size) + int64(size%2)
	}
	return r
}

func readExt80(b []byte) float64 {
	if len(b) < 10 {
		return 0
	}
	exp := int(binary.BigEndian.Uint16(b[:2])&0x7fff) - 16383
	hi := binary.BigEndian.Uint32(b[2:6])
	lo := binary.BigEndian.Uint32(b[6:10])
	mant := float64(hi)/math.Pow(2, 31) + float64(lo)/math.Pow(2, 63)
	return mant * math.Pow(2, float64(exp))
}

func parseFLAC(f *os.File, fileSize int64) metadataResult {
	if string(readAt(f, 0, 4)) != "fLaC" {
		return metadataResult{}
	}
	r := metadataResult{Codec: "flac"}
	for pos := int64(4); pos+4 <= fileSize; {
		h := readAt(f, pos, 4)
		if len(h) < 4 {
			break
		}
		last := h[0]&0x80 != 0
		blockType := h[0] & 0x7f
		size := int64(h[1])<<16 | int64(h[2])<<8 | int64(h[3])
		dataPos := pos + 4
		if size < 0 || size > 64*1024*1024 {
			break
		}
		switch blockType {
		case 0:
			b := readAt(f, dataPos, min64(size, 34))
			if len(b) >= 18 {
				sampleRate := uint32(b[10])<<12 | uint32(b[11])<<4 | uint32(b[12]>>4)
				total := (uint64(b[13]&0x0f) << 32) | uint64(binary.BigEndian.Uint32(b[14:18]))
				if sampleRate > 0 && total > 0 {
					d := float64(total) / float64(sampleRate)
					r.Duration = &d
				}
			}
		case 4:
			parseVorbisComment(readAt(f, dataPos, size), &r.Tags)
		case 6:
			// 画像データ本体は読まない: ヘッダ部 (MIME/説明/サイズ) だけで
			// オフセットと長さが決まる。巨大アートを丸ごと確保しない
			b := readAt(f, dataPos, min64(size, 8192))
			if art := parseFLACPicture(b, dataPos, size); art != nil {
				r.Art = art
			}
		}
		pos = dataPos + size
		if last {
			break
		}
	}
	return r
}

func parseVorbisComment(b []byte, t *tags) {
	if len(b) < 8 {
		return
	}
	p := 0
	vendorLen := int(binary.LittleEndian.Uint32(b[p : p+4]))
	p += 4 + vendorLen
	if p+4 > len(b) {
		return
	}
	count := int(binary.LittleEndian.Uint32(b[p : p+4]))
	p += 4
	for i := 0; i < count && p+4 <= len(b); i++ {
		l := int(binary.LittleEndian.Uint32(b[p : p+4]))
		p += 4
		if l < 0 || p+l > len(b) {
			break
		}
		kv := string(b[p : p+l])
		p += l
		parts := strings.SplitN(kv, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.ToUpper(parts[0])
		val := parts[1]
		switch key {
		case "TITLE":
			t.Title = val
		case "ARTIST":
			t.Artist = val
		case "ALBUM":
			t.Album = val
		case "ALBUMARTIST", "ALBUM ARTIST":
			t.AlbumArtist = val
		case "GENRE":
			t.Genre = val
		case "DATE", "YEAR":
			t.Year = parseYear(val)
		case "TRACKNUMBER":
			t.Track = parseLeadingInt(val)
		}
	}
}

// b はブロック先頭部だけでよい (blockSize はブロック全体のサイズ)
func parseFLACPicture(b []byte, absStart int64, blockSize int64) *artInfo {
	if len(b) < 32 {
		return nil
	}
	p := 4
	mimeLen := int(binary.BigEndian.Uint32(b[p : p+4]))
	p += 4
	if mimeLen < 0 || p+mimeLen+4 > len(b) {
		return nil
	}
	mimeType := string(b[p : p+mimeLen])
	p += mimeLen
	descLen := int(binary.BigEndian.Uint32(b[p : p+4]))
	p += 4 + descLen + 16
	if p+4 > len(b) {
		return nil // 説明文が異常に長い場合はアートなし扱い
	}
	dataLen := int(binary.BigEndian.Uint32(b[p : p+4]))
	p += 4
	if dataLen < 0 || int64(p)+int64(dataLen) > blockSize {
		return nil
	}
	offset := absStart + int64(p)
	return &artInfo{Mime: mimeType, Offset: &offset, Length: int64(dataLen)}
}

type atomInfo struct {
	typ       string
	start     int64
	header    int64
	size      int64
	dataStart int64
}

func parseMP4(f *os.File, fileSize int64) metadataResult {
	r := metadataResult{}
	walkAtoms(f, 0, fileSize, func(a atomInfo) bool {
		switch a.typ {
		case "mvhd":
			b := readAt(f, a.dataStart, min64(a.size-a.header, 112))
			if len(b) >= 20 {
				version := b[0]
				if version == 0 && len(b) >= 20 {
					timescale := binary.BigEndian.Uint32(b[12:16])
					duration := binary.BigEndian.Uint32(b[16:20])
					if timescale > 0 {
						d := float64(duration) / float64(timescale)
						r.Duration = &d
					}
				} else if version == 1 && len(b) >= 32 {
					timescale := binary.BigEndian.Uint32(b[20:24])
					duration := binary.BigEndian.Uint64(b[24:32])
					if timescale > 0 {
						d := float64(duration) / float64(timescale)
						r.Duration = &d
					}
				}
			}
		case "stsd":
			b := readAt(f, a.dataStart, min64(a.size-a.header, 64))
			if len(b) >= 16 {
				// lib/mp4.js と同一のコーデック判別
				switch fmtName := string(b[12:16]); fmtName {
				case "alac":
					r.Codec = "alac"
				case "mp4a":
					r.Codec = "aac"
				case "flac":
					r.Codec = "flac"
				default:
					r.Codec = strings.TrimSpace(fmtName)
				}
			}
		case "\xa9nam":
			setIfEmpty(&r.Tags.Title, readMP4Text(f, a))
		case "\xa9ART":
			setIfEmpty(&r.Tags.Artist, readMP4Text(f, a))
		case "aART":
			setIfEmpty(&r.Tags.AlbumArtist, readMP4Text(f, a))
		case "\xa9alb":
			setIfEmpty(&r.Tags.Album, readMP4Text(f, a))
		case "\xa9gen":
			setIfEmpty(&r.Tags.Genre, readMP4Text(f, a))
		case "\xa9day":
			if r.Tags.Year == nil {
				r.Tags.Year = parseYear(readMP4Text(f, a))
			}
		case "trkn":
			if n := readMP4Track(f, a); n != nil {
				r.Tags.Track = n
			}
		case "gnre":
			// ID3v1 ジャンル番号 + 1 で格納されている (lib/mp4.js と同一)
			if r.Tags.Genre == "" {
				if data, ok := firstDataAtom(f, a); ok {
					b := readAt(f, data.dataStart+8, 2)
					if len(b) == 2 {
						n := int(binary.BigEndian.Uint16(b)) - 1
						if n >= 0 && n < len(id3Genres) {
							r.Tags.Genre = id3Genres[n]
						}
					}
				}
			}
		case "covr":
			if art := readMP4Art(f, a); art != nil {
				r.Art = art
			}
		}
		return true
	})
	return r
}

func walkAtoms(f *os.File, start, end int64, cb func(atomInfo) bool) {
	for pos := start; pos+8 <= end; {
		h := readAt(f, pos, 8)
		if len(h) < 8 {
			return
		}
		size := int64(binary.BigEndian.Uint32(h[:4]))
		header := int64(8)
		typ := string(h[4:8])
		if size == 1 {
			ext := readAt(f, pos+8, 8)
			if len(ext) < 8 {
				return
			}
			size = int64(binary.BigEndian.Uint64(ext))
			header = 16
		} else if size == 0 {
			size = end - pos
		}
		if size < header || pos+size > end {
			return
		}
		a := atomInfo{typ: typ, start: pos, header: header, size: size, dataStart: pos + header}
		if !cb(a) {
			return
		}
		if isContainerAtom(typ) {
			childStart := a.dataStart
			if typ == "meta" {
				childStart += 4
			} else if typ == "stsd" {
				childStart += 8
			}
			if childStart < pos+size {
				walkAtoms(f, childStart, pos+size, cb)
			}
		}
		pos += size
	}
}

func isContainerAtom(typ string) bool {
	switch typ {
	case "moov", "trak", "mdia", "minf", "stbl", "udta", "meta", "ilst", "stsd":
		return true
	default:
		return strings.HasPrefix(typ, "\xa9") || typ == "trkn" || typ == "covr" || typ == "gnre" || typ == "aART"
	}
}

func firstDataAtom(f *os.File, parent atomInfo) (atomInfo, bool) {
	end := parent.start + parent.size
	for pos := parent.dataStart; pos+8 <= end; {
		h := readAt(f, pos, 8)
		if len(h) < 8 {
			return atomInfo{}, false
		}
		size := int64(binary.BigEndian.Uint32(h[:4]))
		if size < 8 || pos+size > end {
			return atomInfo{}, false
		}
		typ := string(h[4:8])
		if typ == "data" {
			return atomInfo{typ: typ, start: pos, header: 8, size: size, dataStart: pos + 8}, true
		}
		pos += size
	}
	return atomInfo{}, false
}

func readMP4Text(f *os.File, item atomInfo) string {
	data, ok := firstDataAtom(f, item)
	if !ok {
		return ""
	}
	b := readAt(f, data.dataStart+8, data.size-data.header-8)
	return strings.TrimSpace(decodeLoose(b))
}

func readMP4Track(f *os.File, item atomInfo) *int {
	data, ok := firstDataAtom(f, item)
	if !ok {
		return nil
	}
	b := readAt(f, data.dataStart+8, data.size-data.header-8)
	if len(b) >= 4 {
		n := int(binary.BigEndian.Uint16(b[2:4]))
		return &n
	}
	return nil
}

func readMP4Art(f *os.File, item atomInfo) *artInfo {
	data, ok := firstDataAtom(f, item)
	if !ok || data.size <= data.header+8 {
		return nil
	}
	h := readAt(f, data.dataStart, 8)
	mimeType := "image/jpeg"
	if len(h) >= 4 && binary.BigEndian.Uint32(h[:4]) == 14 {
		mimeType = "image/png"
	}
	offset := data.dataStart + 8
	return &artInfo{Mime: mimeType, Offset: &offset, Length: data.size - data.header - 8}
}

func (s *appState) serveStream(w http.ResponseWriter, r *http.Request, id string) {
	s.mu.RLock()
	t, ok := s.byID[id]
	s.mu.RUnlock()
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "不明なトラック ID"})
		return
	}
	full, ok := s.resolveTrackPath(t)
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	if r.URL.Query().Get("transcode") == "1" {
		s.serveTranscode(w, r, full)
		return
	}
	f, err := os.Open(full)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "ファイルが見つかりません"})
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "ファイルが見つかりません"})
		return
	}
	total := st.Size()
	start, end, status, ok := parseRange(r.Header.Get("Range"), total)
	if !ok {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", total))
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
		return
	}
	ct := mimeByExt[t.Ext]
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Content-Length", strconv.FormatInt(end-start+1, 10))
	if status == http.StatusPartialContent {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, total))
	}
	w.WriteHeader(status)
	if r.Method == http.MethodHead {
		return
	}
	_, _ = f.Seek(start, io.SeekStart)
	_, _ = io.CopyN(w, f, end-start+1)
}

func rangeDigitsOK(s string) bool {
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

// Node の /^bytes=(\d*)-(\d*)$/ と同一挙動: 形式に合わないヘッダは
// 「Range なし」として全体を 200 で返す (multi-range 等も同様)。
func parseRange(header string, total int64) (int64, int64, int, bool) {
	start, end := int64(0), total-1
	status := http.StatusOK
	if !strings.HasPrefix(header, "bytes=") {
		return start, end, status, true
	}
	spec := strings.TrimPrefix(header, "bytes=")
	dash := strings.IndexByte(spec, '-')
	if dash < 0 {
		return start, end, status, true
	}
	a, b := spec[:dash], spec[dash+1:]
	if !rangeDigitsOK(a) || !rangeDigitsOK(b) || (a == "" && b == "") {
		return start, end, status, true
	}
	if a == "" {
		suffix, err := strconv.ParseInt(b, 10, 64)
		if err != nil {
			return start, end, status, true
		}
		start = total - suffix
		if start < 0 {
			start = 0
		}
	} else {
		n, err := strconv.ParseInt(a, 10, 64)
		if err != nil {
			return start, end, status, true
		}
		start = n
		if b != "" {
			n, err = strconv.ParseInt(b, 10, 64)
			if err != nil {
				return start, end, status, true
			}
			end = min64(n, total-1)
		}
	}
	if start > end || start >= total {
		return 0, 0, 0, false // 416
	}
	return start, end, http.StatusPartialContent, true
}

func (s *appState) serveTranscode(w http.ResponseWriter, r *http.Request, full string) {
	if !s.ffmpeg {
		writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "ffmpeg が見つかりません"})
		return
	}
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	cmd := exec.CommandContext(ctx, "ffmpeg", "-v", "error", "-i", full, "-map", "0:a:0", "-acodec", "pcm_s16le", "-f", "wav", "pipe:1")
	out, err := cmd.StdoutPipe()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "ffmpeg 起動に失敗しました"})
		return
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "ffmpeg 起動に失敗しました"})
		return
	}
	w.Header().Set("Content-Type", "audio/wav")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, out)
	_ = cmd.Wait()
}

func (s *appState) serveArtwork(w http.ResponseWriter, r *http.Request, id string) {
	s.mu.RLock()
	t, ok := s.byID[id]
	s.mu.RUnlock()
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "不明なトラック ID"})
		return
	}
	if t.Art != nil {
		var data []byte
		var err error
		if t.Art.DataBase64 != "" {
			data, err = base64.StdEncoding.DecodeString(t.Art.DataBase64)
		} else if t.Art.Offset != nil && t.Art.Length > 0 && t.Art.Length < 32*1024*1024 {
			full, ok := s.resolveTrackPath(t)
			if ok {
				f, openErr := os.Open(full)
				if openErr == nil {
					data = readAt(f, *t.Art.Offset, t.Art.Length)
					_ = f.Close()
				}
			}
		}
		if err == nil && len(data) > 0 {
			w.Header().Set("Content-Type", t.Art.Mime)
			w.Header().Set("Cache-Control", "public, max-age=86400")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(data)
			return
		}
	}
	if full, ok := s.resolveTrackPath(t); ok {
		if cover := s.findFolderArt(filepath.Dir(full)); cover != "" {
			data, err := os.ReadFile(cover)
			if err == nil {
				ct := "image/jpeg"
				if strings.EqualFold(filepath.Ext(cover), ".png") {
					ct = "image/png"
				}
				w.Header().Set("Content-Type", ct)
				w.Header().Set("Cache-Control", "public, max-age=86400")
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write(data)
				return
			}
		}
	}
	writeJSON(w, http.StatusNotFound, map[string]string{"error": "アートワークなし"})
}

func (s *appState) findFolderArt(dir string) string {
	s.mu.RLock()
	if v, ok := s.folderArt[dir]; ok {
		s.mu.RUnlock()
		return v
	}
	s.mu.RUnlock()
	entries, err := os.ReadDir(dir)
	found := ""
	if err == nil {
		for _, e := range entries {
			name := strings.ToLower(e.Name())
			base := strings.TrimSuffix(name, filepath.Ext(name))
			ext := filepath.Ext(name)
			if (ext == ".jpg" || ext == ".jpeg" || ext == ".png") &&
				(base == "cover" || base == "folder" || base == "front" || base == "album" || base == "jacket" || base == "artwork") {
				found = filepath.Join(dir, e.Name())
				break
			}
		}
	}
	s.mu.Lock()
	s.folderArt[dir] = found
	s.mu.Unlock()
	return found
}

func (s *appState) resolveTrackPath(t track) (string, bool) {
	s.mu.RLock()
	src := s.sources[t.Src]
	s.mu.RUnlock()
	if src == nil {
		return "", false
	}
	base := filepath.Clean(src.Dir)
	full := filepath.Clean(filepath.Join(base, t.Path))
	return full, full == base || strings.HasPrefix(full, base+string(filepath.Separator))
}

// デバッグ用: サーバプロセスの常駐メモリと CPU 使用率 (前回呼び出しからの平均)
func (s *appState) serveStats(w http.ResponseWriter) {
	s.statsMu.Lock()
	now := time.Now()
	cpu := processCPUTime()
	percent := -1.0
	if !s.statsAt.IsZero() && cpu > 0 {
		wall := now.Sub(s.statsAt)
		if wall > 0 {
			percent = float64(cpu-s.statsCPU) / float64(wall) * 100
			if percent < 0 {
				percent = 0
			}
		}
	}
	s.statsCPU = cpu
	s.statsAt = now
	s.statsMu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"rss": processRSS(),
		"cpu": percent,
	})
}

// ブラウザ接続の監視 (--exit-on-close): フロントが張る SSE 接続でページ数を数え、
// 全ページが閉じて猶予時間が過ぎたらプロセスを終了する (server.js servePresence と同一挙動)
const exitGrace = 8 * time.Second

func (s *appState) servePresence(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming unsupported"})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, "retry: 3000\n\n")
	fl.Flush()

	s.presenceMu.Lock()
	s.presenceCount++
	if s.presenceTimer != nil {
		s.presenceTimer.Stop()
		s.presenceTimer = nil
	}
	s.presenceMu.Unlock()

	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			s.presenceMu.Lock()
			s.presenceCount--
			if s.exitOnClose && s.presenceCount <= 0 {
				if s.presenceTimer != nil {
					s.presenceTimer.Stop()
				}
				s.presenceTimer = time.AfterFunc(exitGrace, func() {
					s.presenceMu.Lock()
					n := s.presenceCount
					s.presenceMu.Unlock()
					if n <= 0 {
						fmt.Println("ブラウザが閉じられたため macca を終了します")
						os.Exit(0)
					}
				})
			}
			s.presenceMu.Unlock()
			return
		case <-ticker.C:
			_, _ = io.WriteString(w, ": ping\n\n")
			fl.Flush()
		}
	}
}

func (s *appState) serveDevices(w http.ResponseWriter) {
	devices := listDevices()
	type outDevice struct {
		ID      string `json:"id"`
		Path    string `json:"path"`
		Label   string `json:"label"`
		Scanned bool   `json:"scanned"`
	}
	out := make([]outDevice, 0, len(devices))
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, d := range devices {
		id := sourceID(d.Path)
		out = append(out, outDevice{ID: id, Path: d.Path, Label: d.Label, Scanned: s.sources[id] != nil})
	}
	writeJSON(w, http.StatusOK, map[string]any{"devices": out})
}

type device struct {
	Path  string `json:"path"`
	Label string `json:"label"`
}

func listDevices() []device {
	if raw := os.Getenv("MACCA_TEST_DEVICES"); raw != "" {
		var ds []device
		if json.Unmarshal([]byte(raw), &ds) == nil {
			return ds
		}
	}
	var out []device
	switch runtime.GOOS {
	case "darwin":
		entries, _ := os.ReadDir("/Volumes")
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), ".") {
				continue
			}
			p := filepath.Join("/Volumes", e.Name())
			if real, err := filepath.EvalSymlinks(p); err == nil && real == "/" {
				continue
			}
			out = append(out, device{Path: p, Label: e.Name()})
		}
	case "windows":
		for ch := 'D'; ch <= 'Z'; ch++ {
			p := string(ch) + ":\\"
			if _, err := os.Stat(p); err == nil {
				out = append(out, device{Path: p, Label: string(ch) + ":"})
			}
		}
	default:
		u, _ := user.Current()
		name := ""
		if u != nil {
			name = u.Username
			if strings.Contains(name, string(filepath.Separator)) {
				name = filepath.Base(name)
			}
		}
		for _, base := range []string{filepath.Join("/media", name), filepath.Join("/run/media", name), "/media"} {
			entries, _ := os.ReadDir(base)
			for _, e := range entries {
				if !strings.HasPrefix(e.Name(), ".") {
					out = append(out, device{Path: filepath.Join(base, e.Name()), Label: e.Name()})
				}
			}
		}
		// gvfs が FUSE マウントした MTP デバイス (GNOME 等)。
		// マウント直下はデバイス内ストレージごとのフォルダになっている
		gvfs := fmt.Sprintf("/run/user/%d/gvfs", os.Getuid())
		mounts, _ := os.ReadDir(gvfs)
		for _, m := range mounts {
			if !strings.HasPrefix(m.Name(), "mtp:") {
				continue
			}
			root := filepath.Join(gvfs, m.Name())
			storages, _ := os.ReadDir(root)
			for _, st := range storages {
				out = append(out, device{Path: filepath.Join(root, st.Name()), Label: "MTP: " + st.Name()})
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

func (s *appState) addDeviceSource(w http.ResponseWriter, r *http.Request, useCache bool) {
	var body struct {
		Path string `json:"path"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 64*1024)).Decode(&body)
	reqPath, err := filepath.Abs(body.Path)
	if err != nil || reqPath == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "接続中のデバイスではありません"})
		return
	}
	var found *device
	for _, d := range listDevices() {
		p, _ := filepath.Abs(d.Path)
		if p == reqPath {
			dd := d
			found = &dd
			break
		}
	}
	if found == nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "接続中のデバイスではありません"})
		return
	}
	id := sourceID(found.Path)
	s.mu.Lock()
	if s.sources[id] == nil {
		s.sources[id] = &source{ID: id, Dir: reqPath, Label: found.Label, Removable: true}
	}
	s.mu.Unlock()
	_ = s.rescan(useCache)
	s.serveLibrary(w)
}

func (s *appState) removeDeviceSource(w http.ResponseWriter, id string) {
	s.mu.Lock()
	src := s.sources[id]
	if src == nil {
		s.mu.Unlock()
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "不明なソース ID"})
		return
	}
	if !src.Removable {
		s.mu.Unlock()
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "メインライブラリは取り外せません"})
		return
	}
	delete(s.sources, id)
	s.mu.Unlock()
	s.rebuildIndex()
	s.serveLibrary(w)
}

func writeJSON(w http.ResponseWriter, status int, obj any) {
	data, _ := json.Marshal(obj)
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write(data)
}

func readAt(f *os.File, off, n int64) []byte {
	if n <= 0 {
		return nil
	}
	buf := make([]byte, n)
	read, err := f.ReadAt(buf, off)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil
	}
	return buf[:read]
}

type filenameFallback struct {
	Title  string
	Artist string
}

func fallbackFromFilename(filePath string) filenameFallback {
	base := strings.TrimSuffix(filepath.Base(filePath), filepath.Ext(filePath))
	base = strings.TrimLeft(base, "0123456789")
	base = strings.TrimLeft(base, " ._-")
	parts := strings.SplitN(base, " - ", 2)
	if len(parts) == 2 {
		return filenameFallback{Artist: strings.TrimSpace(parts[0]), Title: strings.TrimSpace(parts[1])}
	}
	return filenameFallback{Title: strings.TrimSpace(base)}
}

func trackID(rootDir, rel string) string {
	sum := sha1.Sum([]byte(absPath(rootDir) + "\x00" + rel))
	return fmt.Sprintf("%x", sum)[:16]
}

func sourceID(dir string) string {
	sum := sha1.Sum([]byte(absPath(dir)))
	return fmt.Sprintf("%x", sum)[:12]
}

func absPath(p string) string {
	a, err := filepath.Abs(p)
	if err != nil {
		return filepath.Clean(p)
	}
	return filepath.Clean(a)
}

func defaultLibraryCandidates(home string) []string {
	sets := [][]string{
		{"Music", "Music", "Media.localized", "Music"},
		{"Music", "Music", "Media.localized"},
		{"Music", "Apple Music", "Media"},
		{"Music", "iTunes", "iTunes Media", "Music"},
		{"Music", "iTunes", "iTunes Media"},
		{"Music", "iTunes", "iTunes Music"},
		{"Music"},
	}
	out := make([]string, 0, len(sets))
	for _, parts := range sets {
		out = append(out, filepath.Join(append([]string{home}, parts...)...))
	}
	return out
}

func findDefaultLibrary() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	for _, dir := range defaultLibraryCandidates(home) {
		if st, err := os.Stat(dir); err == nil && st.IsDir() {
			return dir, nil
		}
	}
	return "", os.ErrNotExist
}

func openBrowser(url string) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", "", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}

func hasCommand(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func value(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func min64(a, b int64) int64 {
	if a < b {
		return a
	}
	return b
}

func syncsafe(b []byte) int {
	if len(b) < 4 {
		return 0
	}
	return int(b[0]&0x7f)<<21 | int(b[1]&0x7f)<<14 | int(b[2]&0x7f)<<7 | int(b[3]&0x7f)
}

func setIfEmpty(dst *string, v string) {
	if *dst == "" && v != "" {
		*dst = v
	}
}

func parseYear(s string) *int {
	for i := 0; i+4 <= len(s); i++ {
		if n, err := strconv.Atoi(s[i : i+4]); err == nil && n > 0 {
			return &n
		}
	}
	return nil
}

func parseLeadingInt(s string) *int {
	s = strings.TrimSpace(s)
	var digits strings.Builder
	for _, r := range s {
		if r < '0' || r > '9' {
			break
		}
		digits.WriteRune(r)
	}
	if digits.Len() == 0 {
		return nil
	}
	n, err := strconv.Atoi(digits.String())
	if err != nil {
		return nil
	}
	return &n
}

// ID3v1 標準ジャンル (lib/id3.js GENRES と同一の 80 エントリ)
var id3Genres = []string{
	"Blues", "Classic Rock", "Country", "Dance", "Disco", "Funk", "Grunge", "Hip-Hop",
	"Jazz", "Metal", "New Age", "Oldies", "Other", "Pop", "R&B", "Rap",
	"Reggae", "Rock", "Techno", "Industrial", "Alternative", "Ska", "Death Metal", "Pranks",
	"Soundtrack", "Euro-Techno", "Ambient", "Trip-Hop", "Vocal", "Jazz+Funk", "Fusion", "Trance",
	"Classical", "Instrumental", "Acid", "House", "Game", "Sound Clip", "Gospel", "Noise",
	"Alternative Rock", "Bass", "Soul", "Punk", "Space", "Meditative", "Instrumental Pop", "Instrumental Rock",
	"Ethnic", "Gothic", "Darkwave", "Techno-Industrial", "Electronic", "Pop-Folk", "Eurodance", "Dream",
	"Southern Rock", "Comedy", "Cult", "Gangsta", "Top 40", "Christian Rap", "Pop/Funk", "Jungle",
	"Native American", "Cabaret", "New Wave", "Psychedelic", "Rave", "Showtunes", "Trailer", "Lo-Fi",
	"Tribal", "Acid Punk", "Acid Jazz", "Polka", "Retro", "Musical", "Rock & Roll", "Hard Rock",
}

// "(17)" や "13" のような ID3v1 番号参照をジャンル名に解決する (Node の /^\(?(\d+)\)?$/ と同一)
func resolveGenre(s string) string {
	t := strings.TrimSpace(s)
	t = strings.TrimPrefix(t, "(")
	t = strings.TrimSuffix(t, ")")
	if t == "" {
		return s
	}
	for _, c := range t {
		if c < '0' || c > '9' {
			return s
		}
	}
	if n, err := strconv.Atoi(t); err == nil && n >= 0 && n < len(id3Genres) {
		return id3Genres[n]
	}
	return s
}

func mergeTags(dst *tags, src tags) {
	if dst.Title == "" {
		dst.Title = src.Title
	}
	if dst.Artist == "" {
		dst.Artist = src.Artist
	}
	if dst.AlbumArtist == "" {
		dst.AlbumArtist = src.AlbumArtist
	}
	if dst.Album == "" {
		dst.Album = src.Album
	}
	if dst.Genre == "" {
		dst.Genre = src.Genre
	}
	if dst.Year == nil {
		dst.Year = src.Year
	}
	if dst.Track == nil {
		dst.Track = src.Track
	}
}
