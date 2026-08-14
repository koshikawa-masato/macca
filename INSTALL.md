# macca のインストールと開発

導入・起動オプション・ソースからの実行・ビルドなど、
[README](README.md) から「丸投げ」された詳しいことはすべてここにあります。

## ダウンロードして入れる（推奨）

[**Releases**](https://github.com/koshikawa-masato/macca/releases) から自分の OS のファイルを
1 つダウンロードするだけです。Node.js などの事前インストールは不要です
（サーバ本体とフロントエンドを 1 つのバイナリに同梱）。

| OS | ファイル | 手順 |
|----|---------|------|
| **macOS** | `macca.dmg` | 開いて macca を Applications へドラッグ |
| **Windows** | `macca.msi` | ダブルクリックでインストール → スタートメニューの「macca」 |
| **Linux** | `macca-linux-*` | `chmod +x` して `./macca-linux-amd64 --open` |

### 初回の警告について

インストーラは未署名のため、初回のみ OS の警告が出ます:

- **macOS** — アプリを右クリック →「開く」
- **Windows** — 「詳細情報」→「実行」

### 更新

- **MSI** — 新しい MSI を上書きインストール
- **DMG** — 新しい macca を Applications へ上書きドラッグ
- **Homebrew** — `brew upgrade macca`

## Homebrew / go install

```sh
# Homebrew (macOS / Linux)
brew install koshikawa-masato/tap/macca

# Go 1.23+ が入っているなら 1 コマンド (全 OS、フロントエンド同梱)
go install github.com/koshikawa-masato/macca/cmd/macca@latest
```

## コマンドラインからの起動とオプション

```
使い方: macca [音楽ディレクトリ] [--port 8323] [--host 127.0.0.1] [--source <dir>]... [--no-cache] [--open] [--exit-on-close]
```

- **音楽ディレクトリ**を省略すると iTunes / ミュージックの標準ライブラリを自動検出します
  （macOS ミュージック.app `~/Music/Music/Media.localized/Music` → Windows 版 Apple Music →
  iTunes `~/Music/iTunes/iTunes Media` → `~/Music` の順）
- `--source <dir>`（複数可）で NAS のマウント先などを追加できます。
  UI の **⚙ フォルダ設定**で「固定」した場所も同じ扱いで、
  `~/.config/macca/sources.json` に記録され次回起動時に自動で読み込まれます
- UI 設定（音量正規化・再生モード・音量・デバッグ表示）は
  `~/.config/macca/settings.json` に保存されます。ブラウザ側ではなく
  サーバ側に持つので、多重起動でポートが変わっても設定は共通です
- `--host 0.0.0.0` にすると同じ LAN 内のスマホなどからも聴けます
  （認証はないので、信頼できるネットワーク内でのみ使ってください。
  この用途では `--exit-on-close` を付けずに起動します）
- `--open` で起動時に既定ブラウザを開き、`--exit-on-close` でページを閉じたら自動終了します
  （ワンクリックランチャーやインストーラ経由の起動はこの組み合わせです）
- **多重起動も可能** — ポートが使用中なら自動的に次のポート (8324, 8325, …) で立ち上がります
- スキャン結果は `~/.cache/macca/` にキャッシュされ、2 回目以降の起動は高速です
  （更新日時・サイズが変わったファイルだけ再読み込み。`--no-cache` で無効化）。
  リムーバブルデバイスのスキャン結果は「固定」しない限りキャッシュに残しません

## MTP 接続のデバイス（Android スマホ・一部の DAP）

MTP はファイルシステムではないため、OS がフォルダとして見せてくれる場合のみ扱えます。
Linux は gvfs マウントを自動検出します。macOS / Windows での現実的な選択肢:

1. デバイス側に **USB ストレージモード**があれば切り替える
2. SD カードを抜いてカードリーダーで挿す → 「デバイス」からスキャン
3. [OpenMTP](https://openmtp.ganeshrvel.com/) 等でいったん PC 側へコピーしてスキャン

## 対応メタデータ

すべて自前実装のパーサで、ファイルの必要な部分だけを読みます
（240GB のライブラリでも全ファイル読み込みはしません）。

| 形式 | コンテナ | 読むもの |
|------|----------|----------|
| .mp3 | ID3v2.2 / 2.3 / 2.4 | タイトル・アーティスト・アルバム・トラック番号・ディスク番号・年・ジャンル・アートワーク、Xing/CBR による再生時間推定 |
| .m4a | MP4 (iTunes 形式 ilst) | 同上 + コーデック判別（ALAC / AAC） |
| .aiff / .aif | IFF (COMM / ID3 チャンク) | 同上 + 正確な再生時間 |
| .flac | Vorbis Comment / PICTURE | 同上 |
| .wav | RIFF (LIST INFO / id3) | 同上 |

タグがないファイルは「`アーティスト - タイトル.mp3`」形式のファイル名から推定します。
NAS / OS のシステムフォルダ（`@Recycle` `#recycle` `$RECYCLE.BIN` など）はスキャンしません。

## ソースから動かす

サーバは **Go 版**（リリースに同梱しているもの）と **Node.js 版**の 2 実装があり、
HTTP API・キャッシュ形式まで完全互換です（パリティテストで担保）。どちらでも動きます:

```sh
git clone https://github.com/koshikawa-masato/macca.git
cd macca
go run ./cmd/macca     # Go 1.23+ の場合
node server.js         # Node.js 18+ の場合
```

ダブルクリック用ランチャーも同梱しています。リポジトリ直下に
`go build -o macca ./cmd/macca` で Go バイナリを置いておくとそれを優先起動し、
なければ Node.js 版を起動します（どちらで動いているかはヘッダのバッジで分かります）:

- **macOS** — `macca.app`（Dock 対応・ターミナル不要）または `macca.command`
- **Windows** — `macca.bat`
- **Linux** — `macca.sh`

うまく動かないときは、ポートを `--port 8080` のように変えるか、
音楽フォルダを引数で直接指定してください。

## 開発

```sh
npm test                                  # 全テスト (Node 実装 + フロントのデコーダ)
go build -o macca ./cmd/macca && \
  MACCA_SERVER_BIN=./macca npm test       # Go 実装に対する受け入れ + パリティテスト
```

合成フィクスチャ（壊れタグ・Shift_JIS 偽装・VBR・ID3v2.2・unsync などの意地悪ケース含む）と
本物の ALAC ファイルで、パーサ・ブラウザ側デコーダ（波形復元精度まで）・HTTP API を検証します。

### ビルド

Go 1.23+ が必要です。フロントエンドは `server/static/public/` にあり、
Go バイナリへ自動で埋め込まれます（コピー等の前処理は不要）。

```sh
go build -o macca ./cmd/macca   # サーバ単体。リポジトリ直下に置くとランチャー/macca.app がこれを優先起動
./build/release.sh              # 全 OS 向けバイナリ一括ビルド → build/release/
./build/dmg/build.sh            # macOS 配布用 DMG (要 macOS)
./build/msi/build.sh            # Windows 配布用 MSI (要 msitools: brew install msitools)
```

普段の開発では再実行不要な生成物のビルド:

```sh
./build/macca-app/build.sh              # macca.app ランチャー (launcher.swift 変更時)
./build/alac-wasm/build.sh              # alac.wasm (要 emscripten)
node build/gen-sjis/gen.mjs > server/sjis.go   # Shift_JIS テーブル
```

### ディレクトリ構成

```
cmd/macca/           Go サーバのエントリポイント (go install 対応)
server/              Go サーバ本体 (リリース版の実体)
server/static/public フロントエンド (素の HTML/CSS/JS。Go バイナリに embed される)
  └ player/          Web Audio 再生エンジン + ALAC(WASM)/AIFF デコーダ
server.js + lib/     Node.js サーバ (同一挙動のリファレンス実装)
macca.app/           macOS 用アプリバンドル
build/
  alac-wasm/         alac.wasm のビルド
  gen-sjis/          Shift_JIS テーブル生成 (Go 用)
  macca-app/         macca.app ランチャーのビルド
  dmg/  msi/         インストーラ生成 (macOS / Windows)
  release.sh         全 OS 向けバイナリの一括ビルド
test/                フィクスチャ生成 + テスト (両実装共通の受け入れテスト)
docs/                仕様書・スクリーンショット
```
