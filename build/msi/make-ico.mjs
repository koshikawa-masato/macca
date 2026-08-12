// icns から Windows ショートカット用の .ico を生成する。
// 256px の PNG を 1 エントリだけ持つ ICO (Vista 以降対応の PNG 埋め込み形式)。
//
//   使い方: node make-ico.mjs <input.icns> <output.ico>

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const [icns, out] = process.argv.slice(2);
const tmp = mkdtempSync(path.join(tmpdir(), 'macca-ico-'));
try {
  const png256 = path.join(tmp, 'icon256.png');
  execFileSync('sips', ['-s', 'format', 'png', '-z', '256', '256', icns, '--out', png256],
    { stdio: 'ignore' });
  const png = readFileSync(png256);

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // 画像数

  const entry = Buffer.alloc(16);
  entry[0] = 0; // width 256
  entry[1] = 0; // height 256
  entry[2] = 0; // palette
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4);  // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(6 + 16, 12); // データオフセット

  writeFileSync(out, Buffer.concat([header, entry, png]));
  console.log(`${out} (${6 + 16 + png.length} bytes)`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
