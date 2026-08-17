import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || fallback) : fallback;
}

const platform = option('--platform', process.platform);
const mode = option('--mode', 'app');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

if (!['darwin', 'win32', 'linux'].includes(platform)) {
  throw new Error(`Unsupported platform: ${platform}`);
}
if (!['app', 'multimodal'].includes(mode)) throw new Error(`Unsupported native check mode: ${mode}`);

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (platform === 'darwin') {
  if (mode === 'app') {
    run(process.execPath, ['macos/AIPRO/app-bundle.test.mjs']);
    run('xcrun', ['swiftc', '-parse-as-library', '-typecheck', 'macos/AIPRO/AIPRO.swift']);
    run('xcrun', ['swiftc', '-typecheck', 'macos/AIPRO/GenerateIcon.swift']);
  } else {
    run('xcrun', ['swiftc', '-typecheck', 'scripts/extract-pdf-ocr.swift']);
  }
}

console.log(`NATIVE_CHECK_OK platform=${platform} mode=${mode}`);
