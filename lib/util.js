// 共通ユーティリティ: ファイル部分読み込みとテキストデコード

/**
 * FileHandle の指定オフセットから len バイト読む。
 * ファイル末尾を越える場合は読めた分だけ返す。
 */
export async function readAt(fh, position, len) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, position);
  return bytesRead === len ? buf : buf.subarray(0, bytesRead);
}

function tryDecode(buf, encoding) {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/**
 * エンコーディング宣言が当てにならないタグ文字列のデコード。
 * ASCII → そのまま / それ以外は UTF-8 → Shift_JIS → Latin-1 の順に試す。
 * (日本語ライブラリでは Latin-1 と偽って Shift_JIS が入っていることが多い)
 */
export function decodeLoose(buf) {
  if (buf.length === 0) return '';
  let ascii = true;
  for (const b of buf) {
    if (b >= 0x80) { ascii = false; break; }
  }
  if (ascii) return buf.toString('ascii');
  return tryDecode(buf, 'utf-8') ?? tryDecode(buf, 'shift_jis') ?? buf.toString('latin1');
}

/** ID3v2 のエンコーディングバイト付きテキストをデコードする */
export function decodeId3Text(encodingByte, buf) {
  let s;
  switch (encodingByte) {
    case 1: { // UTF-16 with BOM
      if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
        s = tryDecode(buf.subarray(2), 'utf-16be') ?? '';
      } else {
        const body = (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) ? buf.subarray(2) : buf;
        s = tryDecode(body, 'utf-16le') ?? '';
      }
      break;
    }
    case 2: // UTF-16BE without BOM
      s = tryDecode(buf, 'utf-16be') ?? '';
      break;
    case 3: // UTF-8
      s = tryDecode(buf, 'utf-8') ?? decodeLoose(buf);
      break;
    default: // 0: 仕様上は ISO-8859-1 だが実態に合わせて緩く解釈
      s = decodeLoose(buf);
  }
  // 終端 NUL と前後空白を除去し、複数値は先頭のみ採用
  return s.replace(/\0+$/g, '').split('\0')[0].trim();
}

/** "3" や "3/12" から先頭の整数を取り出す */
export function parseTrackNumber(s) {
  const m = /^(\d+)/.exec(String(s).trim());
  return m ? Number(m[1]) : null;
}

/** "2011-12-20" 等から年を取り出す */
export function parseYear(s) {
  const m = /(\d{4})/.exec(String(s));
  return m ? Number(m[1]) : null;
}
