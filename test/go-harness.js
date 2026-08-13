import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// テストが実環境の設定 (~/.config/macca の固定ライブラリ記録) を読み込むと、
// ユーザーの NAS 等を勝手にスキャンしてしまう。必ず空の一時ディレクトリに隔離する
// (個別のテストが before() で上書きするのは自由)
if (!process.env.MACCA_CONFIG_DIR) {
  process.env.MACCA_CONFIG_DIR = mkdtempSync(path.join(tmpdir(), 'macca-test-cfg-'));
}

export async function startExternalServer(dir, { sources = [], devices = [] } = {}) {
  const bin = process.env.MACCA_SERVER_BIN;
  if (!bin) return null;

  const args = [dir, '--port', '0', '--host', '127.0.0.1', '--no-cache'];
  for (const source of sources) args.push('--source', source);

  const child = spawn(bin, args, {
    env: {
      ...process.env,
      MACCA_TEST_DEVICES: JSON.stringify(devices),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Go server did not start\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 5000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const m = /macca 起動: (http:\/\/[^\s]+)/.exec(stdout);
      if (m) {
        clearTimeout(timer);
        resolve(m[1].replace(/\/$/, ''));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Go server exited early (${code ?? signal})\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
    child.on('error', reject);
  });

  return {
    base,
    async close() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    },
  };
}
