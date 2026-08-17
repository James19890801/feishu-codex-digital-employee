import assert from 'node:assert/strict';
import { access, copyFile, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDistribution } from './distribution-package.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.equal(packageJson.scripts?.['verify:install'], 'node scripts/verify-install.mjs');
assert.equal(packageJson.scripts?.['setup:dingtalk'], 'node scripts/setup-dingtalk.mjs');

const outputDir = await mkdtemp(join(tmpdir(), 'verify-install-package-'));
const built = await buildDistribution({
  root,
  outputDir,
  version: packageJson.version,
  createArchive: false,
});
const installedRoot = built.directory;
const payloadRoot = join(installedRoot, 'payload');
await access(join(payloadRoot, 'scripts', 'verify-install.mjs'));
await access(join(payloadRoot, 'scripts', 'dingtalk-readiness.mjs'));
await access(join(payloadRoot, 'scripts', 'setup-dingtalk.mjs'));
await copyFile(
  join(payloadRoot, 'config.distribution.json'),
  join(payloadRoot, 'config.local.json'),
);
await mkdir(join(payloadRoot, 'data'), { recursive: true });

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npm, ['run', 'verify:install', '--', '--offline'], {
  cwd: payloadRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    ACHONG_VERIFY_ROOT: payloadRoot,
  },
});
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
assert.match(result.stdout, /VERIFY_INSTALL_OK/u);
assert.match(result.stdout, /PYTHON_READY=false/u);

const sourceResult = spawnSync(npm, ['run', 'verify:install', '--', '--offline'], {
  cwd: root,
  encoding: 'utf8',
});
assert.equal(sourceResult.status, 0, `${sourceResult.stdout}\n${sourceResult.stderr}`);
assert.match(sourceResult.stdout, /CONFIG_SOURCE=config\.distribution\.json/u);

console.log('VERIFY_INSTALL_TEST_OK');
