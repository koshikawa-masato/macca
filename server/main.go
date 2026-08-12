package main

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

type tags struct {
	Title       string
	Artist      string
	AlbumArtist string
	Album       string
	Genre       string
	Year        *int
	Track       *int
}

type metadataResult struct {
	Tags     tags
	Duration *float64
	Codec    string
	Art      *artInfo
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
	Sources   []librarySource `json:"sources"`
	ScannedAt string          `json:"scannedAt"`
	Scanning  bool            `json:"scanning"`
	Ffmpeg    bool            `json:"ffmpeg"`
	Errors    int             `json:"errors"`
	Tracks    []clientTrack   `json:"tracks"`
}

type appState struct {
	mu        sync.RWMutex
	rootDir   string
	publicDir string
	sources   map[string]*source
	tracks    []track
	byID      map[string]track
	scanning  bool
	scannedAt string
	ffmpeg    bool
	folderArt map[string]string
}

type options struct {
	dir       string
	port      string
	host      string
	cache     bool
	open      bool
	publicDir string
	sources   []string
}

type stringList []string

func (s *stringList) String() string { return strings.Join(*s, ",") }
func (s *stringList) Set(v string) error {
	*s = append(*s, v)
	return nil
}

func main() {
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
		fmt.Println("使い方: macca [音楽ディレクトリ] [--port 8323] [--host 127.0.0.1] [--source <dir>]... [--no-cache] [--open] [--public <dir>] [--help]")
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
		rootDir:   root,
		publicDir: resolvePublicDir(opts.publicDir),
		sources:   map[string]*source{},
		byID:      map[string]track{},
		ffmpeg:    hasCommand("ffmpeg"),
		folderArt: map[string]string{},
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
	return state, nil
}

func resolvePublicDir(flagValue string) string {
	if flagValue != "" {
		if p, err := filepath.Abs(flagValue); err == nil {
			return p
		}
		return flagValue
	}
	if p, err := filepath.Abs("public"); err == nil {
		if st, statErr := os.Stat(p); statErr == nil && st.IsDir() {
			return p
		}
	}
	if exe, err := os.Executable(); err == nil {
		p := filepath.Join(filepath.Dir(exe), "public")
		if st, statErr := os.Stat(p); statErr == nil && st.IsDir() {
			return p
		}
	}
	return ""
}

func (s *appState) routes(useCache bool) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		p, err := filepath.Localize(strings.TrimPrefix(r.URL.EscapedPath(), "/"))
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}
		decodedPath, err := filepath.Localize(strings.TrimPrefix(r.URL.Path, "/"))
		if err == nil {
			p = decodedPath
		}
		if r.URL.Path == "/" {
			p = "index.html"
		}
		if strings.HasPrefix(r.URL.Path, "/api/") {
			s.serveAPI(w, r, useCache)
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
		Dir: s.rootDir, Sources: sources, ScannedAt: s.scannedAt, Scanning: s.scanning,
		Ffmpeg: s.ffmpeg, Errors: totalErrors, Tracks: outTracks,
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
				mtimeMs := float64(st.ModTime().UnixNano()) / 1e6
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
	if d, err := os.UserCacheDir(); err == nil {
		return filepath.Join(d, "macca")
	}
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

func estimateMP3Duration(buf []byte, audioSize int64) float64 {
	for i := 0; i+4 <= len(buf); i++ {
		if buf[i] != 0xff || buf[i+1]&0xe0 != 0xe0 {
			continue
		}
		versionBits := (buf[i+1] >> 3) & 0x03
		layerBits := (buf[i+1] >> 1) & 0x03
		bitrateIdx := (buf[i+2] >> 4) & 0x0f
		sampleIdx := (buf[i+2] >> 2) & 0x03
		if versionBits == 1 || layerBits != 1 || bitrateIdx == 0 || bitrateIdx == 15 || sampleIdx == 3 {
			continue
		}
		bitrates := []int{0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320}
		rates := []int{44100, 48000, 32000}
		sampleRate := rates[sampleIdx]
		if versionBits == 2 {
			sampleRate /= 2
		} else if versionBits == 0 {
			sampleRate /= 4
		}
		bitrate := bitrates[bitrateIdx] * 1000
		if bitrate > 0 {
			return float64(audioSize*8) / float64(bitrate)
		}
	}
	return 0
}

func parseID3(buf []byte, absoluteStart int64) metadataResult {
	var r metadataResult
	if len(buf) < 10 || string(buf[:3]) != "ID3" {
		return r
	}
	major := buf[3]
	flags := buf[5]
	size := syncsafe(buf[6:10])
	pos := 10
	end := min(len(buf), 10+size)
	if flags&0x40 != 0 && pos+4 <= end {
		extSize := binary.BigEndian.Uint32(buf[pos : pos+4])
		if major == 4 {
			pos += int(extSize)
		} else {
			pos += int(extSize) + 4
		}
	}
	for pos+10 <= end {
		id := string(buf[pos : pos+4])
		if strings.Trim(id, "\x00") == "" {
			break
		}
		frameSize := int(binary.BigEndian.Uint32(buf[pos+4 : pos+8]))
		if major == 4 {
			frameSize = syncsafe(buf[pos+4 : pos+8])
		}
		dataPos := pos + 10
		if frameSize <= 0 || dataPos+frameSize > end {
			break
		}
		body := buf[dataPos : dataPos+frameSize]
		switch id {
		case "TIT2", "TT2":
			r.Tags.Title = decodeID3Text(body)
		case "TPE1", "TP1":
			r.Tags.Artist = decodeID3Text(body)
		case "TPE2", "TP2":
			r.Tags.AlbumArtist = decodeID3Text(body)
		case "TALB", "TAL":
			r.Tags.Album = decodeID3Text(body)
		case "TCON", "TCO":
			r.Tags.Genre = normalizeGenre(decodeID3Text(body))
		case "TYER", "TDRC", "TYE":
			r.Tags.Year = parseYear(decodeID3Text(body))
		case "TRCK", "TRK":
			r.Tags.Track = parseLeadingInt(decodeID3Text(body))
		case "APIC":
			if art := parseAPIC(body, absoluteStart+int64(dataPos)); art != nil {
				r.Art = art
			}
		}
		pos = dataPos + frameSize
	}
	return r
}

func decodeID3Text(body []byte) string {
	if len(body) == 0 {
		return ""
	}
	enc := body[0]
	raw := trimNull(body[1:])
	switch enc {
	case 0:
		return decodeLoose(raw)
	case 1, 2:
		return decodeUTF16(raw)
	case 3:
		if utf8.Valid(raw) {
			return string(raw)
		}
		return decodeLoose(raw)
	default:
		return decodeLoose(raw)
	}
}

func decodeLoose(raw []byte) string {
	raw = trimNull(raw)
	if len(raw) == 0 {
		return ""
	}
	if utf8.Valid(raw) {
		return string(raw)
	}
	runes := make([]rune, len(raw))
	for i, b := range raw {
		runes[i] = rune(b)
	}
	return string(runes)
}

func decodeUTF16(raw []byte) string {
	if len(raw) == 0 {
		return ""
	}
	be := false
	if len(raw) >= 2 {
		if raw[0] == 0xfe && raw[1] == 0xff {
			be = true
			raw = raw[2:]
		} else if raw[0] == 0xff && raw[1] == 0xfe {
			raw = raw[2:]
		}
	}
	u16 := make([]uint16, 0, len(raw)/2)
	for i := 0; i+1 < len(raw); i += 2 {
		if be {
			u16 = append(u16, binary.BigEndian.Uint16(raw[i:i+2]))
		} else {
			u16 = append(u16, binary.LittleEndian.Uint16(raw[i:i+2]))
		}
	}
	return strings.TrimRight(string(utf16.Decode(u16)), "\x00")
}

func parseAPIC(body []byte, absBodyStart int64) *artInfo {
	if len(body) < 4 {
		return nil
	}
	p := 1
	mimeEnd := bytes.IndexByte(body[p:], 0)
	if mimeEnd < 0 {
		return nil
	}
	mimeType := string(body[p : p+mimeEnd])
	p += mimeEnd + 1
	if p >= len(body) {
		return nil
	}
	p++
	descEnd := bytes.IndexByte(body[p:], 0)
	if descEnd < 0 {
		return nil
	}
	p += descEnd + 1
	if p >= len(body) {
		return nil
	}
	offset := absBodyStart + int64(p)
	return &artInfo{Mime: mimeType, Offset: &offset, Length: int64(len(body) - p)}
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
		val := strings.TrimSpace(decodeLoose(b[p+8 : p+8+size]))
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
		b := readAt(f, dataPos, size)
		switch blockType {
		case 0:
			if len(b) >= 18 {
				sampleRate := uint32(b[10])<<12 | uint32(b[11])<<4 | uint32(b[12]>>4)
				total := (uint64(b[13]&0x0f) << 32) | uint64(binary.BigEndian.Uint32(b[14:18]))
				if sampleRate > 0 && total > 0 {
					d := float64(total) / float64(sampleRate)
					r.Duration = &d
				}
			}
		case 4:
			parseVorbisComment(b, &r.Tags)
		case 6:
			if art := parseFLACPicture(b, dataPos); art != nil {
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

func parseFLACPicture(b []byte, absStart int64) *artInfo {
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
		return nil
	}
	dataLen := int(binary.BigEndian.Uint32(b[p : p+4]))
	p += 4
	if dataLen < 0 || p+dataLen > len(b) {
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
				r.Codec = string(b[12:16])
			}
		case "©nam":
			r.Tags.Title = readMP4Text(f, a)
		case "©ART":
			r.Tags.Artist = readMP4Text(f, a)
		case "aART":
			r.Tags.AlbumArtist = readMP4Text(f, a)
		case "©alb":
			r.Tags.Album = readMP4Text(f, a)
		case "©gen":
			r.Tags.Genre = readMP4Text(f, a)
		case "©day":
			r.Tags.Year = parseYear(readMP4Text(f, a))
		case "trkn":
			if n := readMP4Track(f, a); n != nil {
				r.Tags.Track = n
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
		return strings.HasPrefix(typ, "\xa9") || typ == "trkn" || typ == "covr"
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

func parseRange(header string, total int64) (int64, int64, int, bool) {
	start, end := int64(0), total-1
	status := http.StatusOK
	if header == "" {
		return start, end, status, true
	}
	if !strings.HasPrefix(header, "bytes=") {
		return start, end, status, true
	}
	parts := strings.SplitN(strings.TrimPrefix(header, "bytes="), "-", 2)
	if len(parts) != 2 || (parts[0] == "" && parts[1] == "") {
		return start, end, status, true
	}
	if parts[0] == "" {
		suffix, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil || suffix <= 0 {
			return 0, 0, 0, false
		}
		if suffix > total {
			suffix = total
		}
		start = total - suffix
	} else {
		n, err := strconv.ParseInt(parts[0], 10, 64)
		if err != nil {
			return 0, 0, 0, false
		}
		start = n
		if parts[1] != "" {
			n, err = strconv.ParseInt(parts[1], 10, 64)
			if err != nil {
				return 0, 0, 0, false
			}
			end = min64(n, total-1)
		}
	}
	if start > end || start >= total {
		return 0, 0, 0, false
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

func trimNull(b []byte) []byte {
	for len(b) > 0 && b[len(b)-1] == 0 {
		b = b[:len(b)-1]
	}
	return b
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

var id3Genres = map[int]string{17: "Rock"}

func normalizeGenre(s string) string {
	if strings.HasPrefix(s, "(") {
		end := strings.IndexByte(s, ')')
		if end > 1 {
			if n, err := strconv.Atoi(s[1:end]); err == nil {
				if g := id3Genres[n]; g != "" {
					return g
				}
			}
		}
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
