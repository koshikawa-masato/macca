// リムーバブルストレージ (USB メモリ / SD カード / ポータブルオーディオの
// マスストレージ) の検出。OS がファイルシステムとしてマウントしたものを列挙する。
//
// MTP 接続のデバイスについて:
//  - Linux: gvfs (GNOME 等) が FUSE マウントしていれば検出する (下記)
//  - macOS / Windows: OS が MTP をファイルシステムとして見せないため対象外。
//    OpenMTP / go-mtpfs 等でフォルダにマウントし、server.js の --source で
//    追加するか、デバイス側を USB ストレージモードに切り替えるのが現実的。

import { readdir, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

async function isDir(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * マウント中のリムーバブルボリューム候補を返す。
 * @returns {Promise<{path: string, label: string}[]>}
 */
export async function listRemovableVolumes() {
  const platform = process.platform;
  const out = [];

  if (platform === 'darwin') {
    let names = [];
    try {
      names = await readdir('/Volumes');
    } catch {
      return out;
    }
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const p = path.join('/Volumes', name);
      try {
        // 起動ボリュームは /Volumes 内に自分自身へのリンクとして見えるので除外
        if (await realpath(p) === '/') continue;
        if ((await stat(p)).isDirectory()) out.push({ path: p, label: name });
      } catch {
        // アンマウント中など: スキップ
      }
    }
    return out;
  }

  if (platform === 'win32') {
    // D: 以降のドライブレターを走査 (C: はシステムドライブとして除外)
    for (let c = 0x44; c <= 0x5a; c++) {
      const letter = String.fromCharCode(c);
      const p = `${letter}:\\`;
      if (await isDir(p)) out.push({ path: p, label: `${letter}:` });
    }
    return out;
  }

  // Linux: /media/<user>, /run/media/<user>, /media
  const user = os.userInfo().username;
  const seen = new Set();
  for (const base of [`/media/${user}`, `/run/media/${user}`, '/media']) {
    let names = [];
    try {
      names = await readdir(base);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith('.') || name === user) continue;
      const p = path.join(base, name);
      if (seen.has(p)) continue;
      if (await isDir(p)) {
        seen.add(p);
        out.push({ path: p, label: name });
      }
    }
  }

  // Linux: gvfs が FUSE マウントした MTP デバイス (GNOME のファイラで開いた
  // Android スマホ・DAP など)。マウント直下はデバイス内ストレージごとの
  // フォルダ (内部共有ストレージ / SD カード) になっている。
  if (typeof process.getuid === 'function') {
    const gvfs = `/run/user/${process.getuid()}/gvfs`;
    let mounts = [];
    try {
      mounts = await readdir(gvfs);
    } catch {
      return out;
    }
    for (const mount of mounts) {
      if (!mount.startsWith('mtp:')) continue;
      const root = path.join(gvfs, mount);
      try {
        for (const storage of await readdir(root)) {
          const p = path.join(root, storage);
          if (await isDir(p)) out.push({ path: p, label: `MTP: ${storage}` });
        }
      } catch {
        // デバイスが応答しない等: スキップ
      }
    }
  }
  return out;
}
