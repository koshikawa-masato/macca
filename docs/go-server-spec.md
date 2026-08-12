# macca サーバ Go 移行仕様書

作成日: 2026-08-12 / 対象ブランチ: `claude/go-server-rewrite`

## 1. 目的

localhost サーバのメモリ・CPU 負荷を最大限下げる。あわせて Node.js ランタイムへの
依存をなくし、導入を「バイナリをダブルクリック」まで簡略化する。

| 指標 | 現状 (Node v24) | 目標 (Go) |
|------|----------------|-----------|
| アイドル時 RSS | 実測 約 62 MB | **20 MB 以下** |
| 起動〜listen (キャッシュヒット時) | 数百 ms | **100 ms 以下** |
| 配布物 | リポジトリ + Node.js ランタイム | **シングルバイナリ 10 MB 以下** |
| 外部依存 | Node.js 18+ | **なし** (ffmpeg は従来どおり任意) |

設計原則（README「設計原則」）は移行後も不変:
再生特化 / 軽量 / 再生の邪魔をしない / 音質に妥協しない / 先人の真似をしない。

## 2. スコープ

- **書き直す**: `server.js`, `lib/*.js`（scan / metadata / id3 / mp3 / mp4 / flac / aiff / wav / devices / util）
- **一切変更しない**: `public/` 全体（フロントエンド・player エンジン・alac.wasm）。
  フロントから見た HTTP API は 1 バイトも変わらないこと（完全互換）
- **維持する**: スキャンキャッシュのファイル形式（Node 版と相互運用可能にし、移行をシームレスにする）

## 3. 技術方針

- **Go 1.22+、標準ライブラリのみ**（`net/http`, `encoding/json`, `crypto/sha1`, `os/exec` 等）。
  `go.mod` に外部依存を追加しない
- 例外課題 — 文字化け補正の Shift_JIS デコード: `golang.org/x/text` は依存になるため使わず、
  **CP932 変換テーブルをコード内に内蔵**する（生成スクリプト付き、数十 KB）
- `CGO_ENABLED=0` でクロスコンパイル（darwin/arm64, darwin/amd64, windows/amd64, linux/amd64, linux/arm64）
- `public/` は **`embed.FS` でバイナリに同梱**。開発時は `--public <dir>` でディスク上のファイルを配信
  （リリースバイナリ単体で完結しつつ、フロント開発は再ビルド不要）
- スキャンは goroutine で並列 8（現行と同じ）
- GC 負荷対策: ストリーミングは `io.Copy`（内部で 32KB バッファ再利用）。大きな確保はスキャン時のみ

## 4. CLI 仕様（現行と完全互換 + バイナリ名変更）

```
使い方: macca [音楽ディレクトリ] [--port 8323] [--host 127.0.0.1]
             [--source <dir>]... [--no-cache] [--open] [--public <dir>] [--help]
```

- ディレクトリ省略時の自動検出優先順（現行 `defaultLibraryCandidates` と同一）:
  1. `~/Music/Music/Media.localized/Music`（macOS ミュージック.app）
  2. `~/Music/Music/Media.localized`
  3. `~/Music/Apple Music/Media`（Windows 版 Apple Music）
  4. `~/Music/iTunes/iTunes Media/Music` → `iTunes Media` → `iTunes Music`
  5. `~/Music`
- `--source`: 追加ライブラリフォルダ（複数可、removable=false）
- `--open`: listen 後に既定ブラウザを開く（darwin: `open` / windows: `cmd /c start` / linux: `xdg-open`）
- 起動ログの文言・形式も現行を踏襲する

## 5. HTTP API 仕様（完全互換）

すべて現行実装が正。以下は要点のみ。疑義があれば Node 実装 (`server.js`) の挙動に合わせる。

### 5.1 静的配信
- `GET /` → `index.html`。`public/` 配下を配信
- MIME: `.html/.js/.css/.svg/.png/.ico/.wasm`（`application/wasm` 必須 — WASM streaming compile のため）、
  その他は `application/octet-stream`
- パストラバーサル拒否（解決後パスが public 外なら 404）
- `Cache-Control: no-cache`

### 5.2 `GET /api/library`
```jsonc
{
  "dir": "…メインライブラリの絶対パス…",
  "sources": [{ "id": "12hex", "dir": "…", "label": "…",
                 "removable": false, "tracks": 0, "errors": 0 }],
  "scannedAt": "ISO8601", "scanning": false, "ffmpeg": true,
  "errors": 0,
  "tracks": [{
    "id": "16hex", "src": "12hex", "path": "相対パス", "ext": ".mp3",
    "size": 0, "title": "…", "artist": null, "albumArtist": null,
    "album": null, "genre": null, "year": null, "track": null,
    "duration": null, "codec": "mp3", "hasArt": false
  }]
}
```
- `null` は JSON null で出力（省略しない）。フィールド順は問わない
- 既定ソート: アーティスト → アルバム → トラック番号 → タイトル。
  照合順序は Unicode コードポイント順で可（表示順の厳密な日本語照合はフロントで行われるため差異許容）

### 5.3 その他 API
- `POST /api/rescan` → 全ソース再スキャンして library を返す
- `GET /api/devices` → `{devices: [{id, path, label, scanned}]}`
- `POST /api/source` body `{path}` → **現在マウント中のデバイスに限り**追加スキャン（それ以外は 400）。
  成功で library を返す
- `DELETE /api/source/{12hex}` → removable のみ削除可（メインは 400、不明 ID は 404）。library を返す
- `GET|HEAD /api/stream/{16hex}`
  - Range 対応: `bytes=a-b` / `bytes=a-` / `bytes=-suffix`、200/206/416、
    `Accept-Ranges: bytes`, `Content-Range: bytes a-b/total`
  - `?transcode=1`: ffmpeg (`-acodec pcm_s16le -f wav pipe:1`) を spawn して
    `audio/wav` をチャンク転送。クライアント切断で ffmpeg を kill。ffmpeg なしは 501
- `GET /api/artwork/{16hex}`
  - 埋め込みアート（キャッシュ済み base64、またはファイル内 offset+length を読む）
  - なければ同フォルダの `(cover|folder|front|album|jacket|artwork).(jpe?g|png)`（大文字小文字無視）
  - `Cache-Control: public, max-age=86400`
- エラーは `{"error": "…"}` の JSON（404/400/500/501）

### 5.4 ID 仕様（互換必須）
- `trackId = sha1(絶対ルートパス + "\x00" + 相対パス)` の先頭 16 hex
- `sourceId = sha1(絶対パス)` の先頭 12 hex
- キャッシュファイル名 = `library-` + `sha1(絶対ルートパス)` 先頭 12 hex + `.json`

## 6. メタデータパーサ仕様

対象拡張子: `.mp3 .m4a .m4b .aac .aif .aiff .aifc .flac .wav .ogg .oga .opus`
（ogg/opus はパーサなし、ファイル名フォールバックのみ — 現行同様）

**ファイルの必要な部分だけを読む**（全読み込み禁止。現行の readAt 相当）。

| 形式 | 読むもの | 正とする現行実装 |
|------|---------|------------------|
| mp3  | ID3v2.2/2.3/2.4（unsync・拡張ヘッダ対応）、Xing/Info または CBR による時間推定 | `lib/id3.js` `lib/mp3.js` |
| m4a  | moov→mvhd(時間)/stsd(codec: alac/aac/flac)/udta.meta.ilst（©nam ©ART aART ©alb ©gen ©day trkn gnre covr） | `lib/mp4.js` |
| flac | STREAMINFO(時間)・VORBIS_COMMENT・PICTURE | `lib/flac.js` |
| aiff | COMM(時間, ext80)・ID3 チャンク | `lib/aiff.js` |
| wav  | fmt(時間)・LIST INFO・id3 チャンク | `lib/wav.js` |

- **文字化け補正**（音質と並ぶ差別化点。挙動を厳密に再現すること）:
  ID3 の encoding=0 (Latin-1) 宣言のバイト列を UTF-8 / Shift_JIS (CP932) として
  妥当か検査し、妥当ならそちらでデコード（`lib/util.js` の推定ロジックが正）
- タグ欠落時のフォールバック: ファイル名 `"01 Artist - Title.ext"` 形式から artist/title 推定
- アートワーク: 埋め込み位置 (offset+length) を保持し配信時に読む。unsync 解除等で
  バイト列が変わる場合のみ base64 でキャッシュに保持（現行同様）

## 7. スキャン・キャッシュ仕様

- 再帰走査: 隠しファイル (`.` 始まり) 除外、対象拡張子のみ、並列 8
- キャッシュ: `~/.cache/macca/library-<12hex>.json`
  `{"version":1,"files":{"<相対パス>":{"mtimeMs":0,"size":0,"meta":{…}}}}`
  - **Node 版と読み書き互換**（数値の精度・キー名を維持。mtimeMs はミリ秒 float）
  - mtime+size 一致でメタデータ再利用
- **removable ソースはキャッシュを読みも書きもしない**（プライバシー仕様、現行同様）
- スキャン失敗したソースは tracks=[] + errors に記録して残す（デバイス抜去対応）

## 8. デバイス検出仕様

- darwin: `/Volumes` 直下（`realpath == "/"` の起動ボリュームと `.` 始まりを除外）
- windows: `D:`〜`Z:` の存在するドライブ
- linux: `/media/<user>`, `/run/media/<user>`, `/media` + gvfs MTP
  (`/run/user/<uid>/gvfs/mtp:*/<ストレージ>` → ラベル `MTP: <名前>`)

## 9. ビルド・配布

- `go build`（`CGO_ENABLED=0 -trimpath -ldflags "-s -w"`）
- ターゲット: darwin/arm64, darwin/amd64, windows/amd64, linux/amd64, linux/arm64
- `build/release.sh` で全ターゲット一括ビルド → GitHub Releases に添付
- ランチャー (`macca.command` / `macca.bat` / `macca.sh`) は
  「同じフォルダに macca バイナリがあればそれを起動、なければ従来どおり node server.js」
  に変更（移行期の両対応）
- リポジトリ構成: Go ソースは `server/`（`server/main.go`, `server/internal/...`）。
  Node 版 (`server.js`, `lib/`) はパリティ確認完了まで削除しない

## 10. テスト戦略

1. **受け入れテスト（言語非依存・最重要）**: 既存の `test/*.test.js` は HTTP レベルの
   検証なので、環境変数 `MACCA_SERVER_BIN=<goバイナリ>` があるとき Node の
   `createServer` の代わりに Go バイナリを子プロセス起動して同じテストを流す
   ハーネス（`test/go-harness.js`、実装済み）を使う。
   **全テストがそのままパスすること = API 互換の定義**
   - ハーネス契約: 引数 `<dir> --port 0 --host 127.0.0.1 --no-cache [--source d]...`
   - **`--port 0` 対応必須**: OS 割り当てポートで listen し、実際のポートを
     `macca 起動: http://127.0.0.1:<port>/` 形式で stdout に出力すること
   - **`MACCA_TEST_DEVICES` 環境変数**: `[{"path":"…","label":"…"}]` 形式の JSON が
     設定されていたら、実デバイス検出の代わりにこれをデバイス一覧として使う（テスト専用）
   - 終了は SIGTERM で行う（クリーンに終了すること）
2. **パーサのパリティテスト**: 同一フィクスチャ（`test/fixtures.js` 生成物 +
   `test/data/alac-sine.m4a`）に対し、Go 版の出力メタデータ JSON が Node 版と
   完全一致することを確認するスクリプト
3. Go 側ユニットテスト（`go test`）: パーサ・Range 処理・パス防御・ID 生成
4. 非機能の実測: RSS / 起動時間 / 1 万曲相当の合成ライブラリでのスキャン時間を
   Node 版と比較して記録する

## 11. 移行フェーズ

| Phase | 内容 | 完了条件 |
|-------|------|---------|
| 1 | HTTP スケルトン + 静的配信 (embed) + stream/Range/HEAD | ブラウザで UI が開き既存 Node スキャン API へのプロキシなしで静的部が動く |
| 2 | パーサ移植 (wav → aiff → flac → id3/mp3 → mp4) + CP932 テーブル | パーサのパリティテスト一致 |
| 3 | スキャン + キャッシュ + `/api/library` + `/api/rescan` | 受け入れテストの library/stream/artwork 系パス |
| 4 | デバイス + source API + transcode + `--open` + 自動検出 | 受け入れテスト全パス |
| 5 | ランチャー更新・release.sh・実測比較・README 更新 | 非機能目標達成の実測記録 |

## 12. リスク と 対策

- **文字コード推定の再現差** → パリティテストに壊れタグのフィクスチャを含める（既存 fixtures が該当）
- **CP932 テーブルの実装コスト** → 生成スクリプトで機械生成し、レビュー対象はロジックのみに絞る
- **JSON 数値表現の差**（mtimeMs の float 精度等）→ キャッシュ互換テストで担保
- **embed.FS と開発フロー** → `--public` フラグで回避
- **日本語照合順序の差** → 仕様として許容（5.2 に明記）。問題になればフロントでソート
