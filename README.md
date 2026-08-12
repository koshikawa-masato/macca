# macca

**iTunes（Apple Music アプリ）を使わずに、ローカルの音楽ファイルを管理・再生する Web アプリ。**

mp3 / AIFF / ALAC (m4a) / AAC / FLAC / WAV の入ったフォルダを指定してサーバを起動するだけで、
ブラウザからライブラリの閲覧・検索・再生ができます。
**依存パッケージゼロ**（Node.js 標準ライブラリのみ）で、`npm install` も ffmpeg も不要。
ファイルには一切書き込まず読み取り専用で動くので、既存のライブラリを壊す心配がありません。

![曲一覧](docs/screenshot-songs.png)

## 背景

Apple 純正アプリでローカルファイルとサブスクを同時に管理するのは厳しい
（iTunes Match の同期でファイルが壊れる、非圧縮・可逆音源が数百 GB あると管理不能）
という問題意識から作られています。

- **ライブラリの実体はただのフォルダ構成**。macca はそれをスキャンして表示するだけで、
  独自データベースにファイルを取り込んだり移動したりしません
- Apple 純正アプリはサブスク再生専用と割り切り、手元のファイルは macca（または後述の代替アプリ）で管理する運用を想定しています

## 使い方

Node.js 18 以上があれば動きます（macOS / Linux / Windows）。

```sh
git clone https://github.com/koshikawa-masato/macca.git
cd macca
node server.js
```

起動したら `http://127.0.0.1:8323/` をブラウザで開くだけです。

```
使い方: node server.js [音楽ディレクトリ] [--port 8323] [--host 127.0.0.1] [--no-cache]
```

ディレクトリを省略すると、**iTunes / ミュージックの標準ライブラリを自動検出**します
（優先順: macOS ミュージック.app `~/Music/Music/Media.localized/Music` →
Windows 版 Apple Music → iTunes `~/Music/iTunes/iTunes Media` → `~/Music`）。
もちろん任意のフォルダを明示的に指定しても構いません。

- 初回スキャン結果は `~/.cache/macca/` にキャッシュされ、2 回目以降の起動は高速です
  （ファイルの更新日時・サイズが変わったものだけ再読み込み）
- `--host 0.0.0.0` にすると同じ LAN 内のスマホなどからも聴けます
  （認証はないので、信頼できるネットワーク内でのみ使ってください）

### ブラウザと再生形式について

**全対応形式（MP3 / AAC / ALAC / AIFF / FLAC / WAV）がすべてのモダンブラウザで再生できます。ffmpeg は不要です。**

ブラウザがネイティブ再生できない ALAC と AIFF は、macca に同梱のデコーダで
ブラウザ内デコードします（ロスレス・シーク可能）:

- **ALAC**: Apple がオープンソース化した公式デコーダ（Apache 2.0）を WASM 化して同梱（わずか 16KB）
- **AIFF**: 実質ビッグエンディアン PCM なので純 JS でデコード

サーバに ffmpeg があれば、それ以外の未知の形式に当たったときのフォールバック
（WAV へのロスレス変換ストリーミング）としてだけ使われます。

### 再生エンジン

`<audio>` タグ任せにせず、Web Audio API ベースの再生エンジンを実装しています:

- **ギャップレス再生** — 次の曲を先読みデコードし、現在の曲の終端にサンプル精度で連結。
  ライブ盤・クラシック・コンセプトアルバムが途切れません
- **リサンプリング回避** — AudioContext を音源のサンプルレートに合わせて生成するため、
  44.1kHz の音源が不用意に 48kHz へ変換されて劣化することがありません
- **音量正規化**（プレーヤ右下の「N」ボタン）— デコード済み PCM から実測した
  ラウドネスで曲間の音量差を揃えます（iTunes のサウンドチェックに相当。ファイルは変更しません）

## 機能

![アルバム](docs/screenshot-albums.png)

- 曲・アルバム・アーティストの 3 ビュー、インクリメンタル検索、列ソート
- フォーマット別フィルタ（MP3 / ALAC / AIFF / FLAC …）— 「非圧縮のものだけ聴きたい」に対応
- 埋め込みアートワーク表示（ID3 APIC / MP4 covr / FLAC PICTURE）、
  なければフォルダ内の `cover.jpg` / `folder.jpg` 等にフォールバック
- シャッフル・リピート・キーボード操作（Space で再生/停止）・OS のメディアキー対応
- 文字化け対策: エンコーディング宣言が壊れたタグ（Latin-1 と偽った Shift_JIS / UTF-8）を推定してデコード
- **USB / SD カードのスキャン** — サイドバーの「デバイス」に接続中のリムーバブルストレージ
  （USB メモリ、SD カード、マスストレージ接続のポータブルオーディオ）が表示され、
  ワンクリックでライブラリに統合できます。取り外してもファイルには一切触れません
  （macOS は `/Volumes`、Windows はドライブレター、Linux は `/media` と gvfs を監視）
- **追加ライブラリフォルダ** — `--source <dir>`（複数指定可）で NAS のマウント先などを
  メインライブラリと併せて配信できます

### MTP 接続のデバイス（Android スマホ・一部の DAP）について

MTP はファイルシステムではないため、OS がフォルダとして見せてくれる場合のみ扱えます:

- **Linux** — GNOME 等のファイラでデバイスを開くと gvfs が FUSE マウントするので、
  そのまま「デバイス」に `MTP: 内部共有ストレージ` などとして現れます
- **macOS / Windows** — OS 標準では MTP をフォルダとして見せる仕組みがありません。
  [OpenMTP](https://openmtp.ganeshrvel.com/) などの転送アプリも「アプリ内からファイルを
  コピーできる」だけで、他のアプリが読めるフォルダとしてはマウントされない点に注意。
  現実的な選択肢は次の通りです:
  1. デバイス側に **USB ストレージモード**があれば切り替える（対応機種のみ。
     Android ベースの DAP は MTP のみの場合が多い）
  2. SD カードを抜いてカードリーダーで挿す → 「デバイス」からスキャン
  3. OpenMTP 等でいったん Mac 側のフォルダにコピーし、そのフォルダをスキャンする
  4. go-mtpfs + [macFUSE](https://macfuse.github.io/) でフォルダにマウントして `--source` で
     追加する（macFUSE はカーネル拡張の許可が必要で、MTP 越しのスキャンは遅め）

### 対応メタデータ

すべて自前実装のパーサで、ファイルの必要な部分だけを読みます（240GB のライブラリでも全ファイル読み込みはしません）。

| 形式 | コンテナ | 読むもの |
|------|----------|----------|
| .mp3 | ID3v2.2 / 2.3 / 2.4 | タイトル・アーティスト・アルバム・トラック番号・年・ジャンル・アートワーク、Xing/CBR による再生時間推定 |
| .m4a | MP4 (iTunes 形式 ilst) | 同上 + コーデック判別（ALAC / AAC） |
| .aiff / .aif | IFF (COMM / ID3 チャンク) | 同上 + 正確な再生時間 |
| .flac | Vorbis Comment / PICTURE | 同上 |
| .wav | RIFF (LIST INFO / id3) | 同上 |

タグがないファイルは「`アーティスト - タイトル.mp3`」形式のファイル名から推定します。

## 開発

```sh
npm test        # Node 標準の node:test で 17 テスト（外部依存なし）
```

テストは合成した mp3 / m4a (ALAC) / AIFF / FLAC / WAV フィクスチャと本物の ALAC ファイル
（afconvert で生成しコミット済み）を使い、パーサ・ブラウザ側デコーダ（ALAC の波形復元精度まで）・
HTTP API（Range リクエスト・アートワーク配信・パストラバーサル拒否）を検証します。

```
server.js            HTTP サーバ (ストリーミング / API / 静的配信)
lib/
  scan.js            ライブラリスキャン + キャッシュ
  metadata.js        拡張子ごとのディスパッチ
  id3.js             ID3v2 パーサ
  mp3.js             MP3 再生時間推定
  mp4.js             MP4/M4A (ALAC/AAC) パーサ
  flac.js            FLAC パーサ
  aiff.js            AIFF パーサ
  wav.js             WAV パーサ
public/              フロントエンド (素の HTML/CSS/JS)
public/player/
  engine.js          Web Audio 再生エンジン (ギャップレス / 正規化 / レート追従)
  demux-mp4.js       MP4 デマルチプレクサ (ALAC パケット抽出)
  alac.js + alac.wasm  Apple ALAC デコーダ (WASM, Apache 2.0)
  decode-aiff.js     AIFF 純 JS デコーダ
  probe.js           サンプルレート検出
  loudness.js        音量正規化ゲイン計算
build/alac-wasm/     alac.wasm のビルドスクリプト (通常は再実行不要)
test/                フィクスチャ生成 + テスト
```

## 既製品という選択肢

自分でホストするより既製アプリが合う場合の代表例:

- **[Swinsian](https://swinsian.com/)** (macOS・有料) — iTunes 代替のド定番。大規模ライブラリに強い
- **[foobar2000](https://www.foobar2000.org/)** (Windows/macOS・無料) — 老舗。プラグインで何でもできる
- **[Doppler](https://brushedtype.co/doppler/)** (macOS/iOS・有料) — モダン UI のローカル再生専用
- **[Navidrome](https://www.navidrome.org/)** / **[Jellyfin](https://jellyfin.org/)** (セルフホスト・無料) — 常時起動サーバがあるなら。外出先からも聴ける
- **[Plexamp](https://www.plex.tv/plexamp/)** (Plex Pass) — セルフホスト系で音質・UI とも完成度が高い
- **[beets](https://beets.io/)** (CLI・無料) — タグ整理・リネームの自動化に

macca はこれらと違い「インストール不要・データベース不要・ファイル非破壊」を重視した最小構成です。

## ロードマップ

- [x] ギャップレス再生
- [x] ALAC / AIFF のブラウザ内デコード（ffmpeg 不要化）
- [x] 音量正規化
- [x] USB / SD カード / ポータブルオーディオのスキャン
- [ ] プレイリスト（M3U 読み書き）
- [ ] タグ編集
- [ ] Ogg Vorbis / Opus のメタデータパース（再生は対応済み）

## ライセンス

MIT。同梱の `public/player/alac.wasm` は
[Apple Lossless Audio Codec](https://github.com/macosforge/alac)（Apache License 2.0）を
WASM にビルドしたものです。
