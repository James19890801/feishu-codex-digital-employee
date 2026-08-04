import assert from 'node:assert/strict';
import {
  access,
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDistribution } from './distribution-package.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
await access(join(root, 'install.command'));
await access(join(root, 'scripts', 'install-aicoding.mjs'));

const sandbox = await mkdtemp(join(tmpdir(), 'james-installer-'));
const output = join(sandbox, 'package');
const home = join(sandbox, 'home');
const installRoot = join(sandbox, 'installed', 'AchongDigitalHuman');
const launchctlLog = join(sandbox, 'launchctl.log');
const launchctl = join(sandbox, 'launchctl-stub');
const standaloneDws = join(sandbox, 'standalone-dws');
await mkdir(home, { recursive: true });
await writeFile(launchctl, `#!/bin/sh
printf '%s\n' "$*" >> "$ACHONG_LAUNCHCTL_LOG"
if [ "$1" = "print" ]; then exit 1; fi
if [ "${'$'}{ACHONG_LAUNCHCTL_FAIL:-0}" = "1" ] && [ "$1" = "bootstrap" ]; then exit 9; fi
exit 0
`, 'utf8');
await chmod(launchctl, 0o755);
await writeFile(standaloneDws, '#!/bin/sh\nexit 0\n', 'utf8');
await chmod(standaloneDws, 0o755);

async function packageDirectory() {
  return (await buildDistribution({ root, outputDir: output, version: '1.0.0' })).directory;
}

function install(directory, extraEnv = {}) {
  return spawnSync('/bin/zsh', [join(directory, 'install.command')], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      ACHONG_INSTALL_ROOT: installRoot,
      ACHONG_INSTALL_HOME: home,
      ACHONG_LAUNCHCTL: launchctl,
      ACHONG_LAUNCHCTL_LOG: launchctlLog,
      ACHONG_SKIP_DEPENDENCIES: '1',
      ACHONG_SKIP_OPEN: '1',
      ACHONG_SERVICE_RETRIES: '1',
      ACHONG_SERVICE_WAIT_SECONDS: '0',
      JAMES_DWS_BIN: standaloneDws,
      ...extraEnv,
    },
  });
}

const directory = await packageDirectory();
let result = install(directory);
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
assert.match(result.stdout, /INSTALL_OK/);
assert.match(result.stdout, /http:\/\/127\.0\.0\.1:17655/);
const config = JSON.parse(await readFile(join(installRoot, 'config.local.json'), 'utf8'));
assert.equal(config.feishuEnabled, false);
assert.equal(config.dingtalkEnabled, true);
assert.equal(config.dingtalkTransport, 'event-stream');
assert.equal(config.dingtalkBin, await realpath(standaloneDws));
assert.equal(config.allowAllChats, false);
assert.deepEqual(config.authorizedChatIds, ['__SETUP_REQUIRED__']);

const wukongDws = join(sandbox, '.real', '.bin', 'dws', 'bin', 'dws');
await mkdir(join(wukongDws, '..'), { recursive: true });
await writeFile(wukongDws, '#!/bin/sh\nexit 0\n', 'utf8');
await chmod(wukongDws, 0o755);
const rejectedRoot = join(sandbox, 'installed', 'RejectedWukong');
result = install(directory, {
  ACHONG_INSTALL_ROOT: rejectedRoot,
  JAMES_DWS_BIN: wukongDws,
});
assert.notEqual(result.status, 0);
assert.match(`${result.stdout}\n${result.stderr}`, /Wukong is not allowed/i);

const calls = (await readFile(launchctlLog, 'utf8')).trim().split('\n');
assert.equal(calls.filter(call => call.startsWith('bootstrap ')).length, 2);
for (const label of [
  'com.local.feishu-codex-digital-employee.plist',
  'com.local.feishu-codex-dashboard.plist',
]) {
  const plist = await readFile(join(home, 'Library', 'LaunchAgents', label), 'utf8');
  assert.match(plist, new RegExp(installRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

await writeFile(join(installRoot, 'config.local.json'), '{"preserved":true}\n', 'utf8');
await writeFile(join(installRoot, 'PERSONA.md'), 'preserved persona\n', 'utf8');
await writeFile(join(installRoot, 'BIBLE.md'), 'preserved bible\n', 'utf8');
await mkdir(join(installRoot, 'data'), { recursive: true });
await writeFile(join(installRoot, 'data', 'marker.txt'), 'preserved data\n', 'utf8');
await writeFile(launchctlLog, '', 'utf8');
result = install(directory);
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
assert.equal(await readFile(join(installRoot, 'config.local.json'), 'utf8'), '{"preserved":true}\n');
assert.equal(await readFile(join(installRoot, 'PERSONA.md'), 'utf8'), 'preserved persona\n');
assert.equal(await readFile(join(installRoot, 'BIBLE.md'), 'utf8'), 'preserved bible\n');
assert.equal(await readFile(join(installRoot, 'data', 'marker.txt'), 'utf8'), 'preserved data\n');

const tampered = await packageDirectory();
await writeFile(join(tampered, 'payload', 'src', 'operator-profile.mjs'), 'tampered\n', 'utf8');
result = install(tampered);
assert.notEqual(result.status, 0);
assert.match(`${result.stdout}\n${result.stderr}`, /checksum/i);
assert.equal(await readFile(join(installRoot, 'data', 'marker.txt'), 'utf8'), 'preserved data\n');

const rollbackPackage = await packageDirectory();
result = install(rollbackPackage, { ACHONG_LAUNCHCTL_FAIL: '1' });
assert.notEqual(result.status, 0);
assert.match(`${result.stdout}\n${result.stderr}`, /rollback/i);
assert.equal(await readFile(join(installRoot, 'config.local.json'), 'utf8'), '{"preserved":true}\n');
assert.equal(await readFile(join(installRoot, 'data', 'marker.txt'), 'utf8'), 'preserved data\n');

console.log('INSTALL_AICODING_TEST_OK');
