import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'james-install-service-'));
const binDirectory = join(directory, 'bin');
const logPath = join(directory, 'launchctl.log');

try {
  await import('node:fs/promises').then(({ mkdir }) => mkdir(binDirectory));
  const launchctlPath = join(binDirectory, 'launchctl');
  await writeFile(
    launchctlPath,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$LAUNCHCTL_LOG"\n[ "$1" = "print" ] && exit 1\nexit 0\n',
    'utf8',
  );
  await chmod(launchctlPath, 0o755);

  const result = spawnSync('/bin/zsh', ['scripts/install-service.sh'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: directory,
      PATH: `${binDirectory}:/usr/local/bin:/usr/bin:/bin`,
      LAUNCHCTL_LOG: logPath,
      JAMES_SERVICE_LOCK_PATH: join(directory, 'service.lock'),
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const calls = (await readFile(logPath, 'utf8')).trim().split('\n');
  assert.equal(calls.some(call => call.startsWith('bootout ')), true);
  assert.equal(calls.some(call => call.startsWith('print ')), true);
  assert.equal(calls.filter(call => call.startsWith('bootstrap ')).length, 1);
  assert.equal(calls.some(call => call.startsWith('kickstart ')), false);
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log('INSTALL_SERVICE_TEST_OK');
