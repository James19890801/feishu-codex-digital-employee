import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'aipro-dashboard-service-'));
const binDirectory = join(directory, 'bin');
const injectedLog = join(directory, 'injected-launchctl.log');
const pathTrapLog = join(directory, 'path-launchctl.log');

try {
  await import('node:fs/promises').then(({ mkdir }) => mkdir(binDirectory));
  const injectedLaunchctl = join(directory, 'launchctl-stub');
  await writeFile(injectedLaunchctl,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$INJECTED_LAUNCHCTL_LOG"\nexit 0\n', 'utf8');
  await chmod(injectedLaunchctl, 0o755);
  const pathLaunchctl = join(binDirectory, 'launchctl');
  await writeFile(pathLaunchctl,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PATH_LAUNCHCTL_LOG"\nexit 0\n', 'utf8');
  await chmod(pathLaunchctl, 0o755);
  await writeFile(injectedLog, '', 'utf8');
  await writeFile(pathTrapLog, '', 'utf8');

  const result = spawnSync('/bin/zsh', ['scripts/install-dashboard-service.sh'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: directory,
      PATH: `${binDirectory}:/usr/local/bin:/usr/bin:/bin`,
      ACHONG_LAUNCHCTL: injectedLaunchctl,
      ACHONG_SERVICE_RETRIES: '1',
      ACHONG_SERVICE_WAIT_SECONDS: '0',
      INJECTED_LAUNCHCTL_LOG: injectedLog,
      PATH_LAUNCHCTL_LOG: pathTrapLog,
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const calls = (await readFile(injectedLog, 'utf8')).trim().split('\n').filter(Boolean);
  assert.equal(calls.some(call => call.startsWith('bootout ')), true);
  assert.equal(calls.some(call => call.startsWith('bootstrap ')), true);
  assert.equal(calls.some(call => call.startsWith('kickstart ')), true);
  assert.equal((await readFile(pathTrapLog, 'utf8')).trim(), '',
    'dashboard installer tests must never resolve launchctl through PATH');
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log('INSTALL_DASHBOARD_SERVICE_TEST_OK');
