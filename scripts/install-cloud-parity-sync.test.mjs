import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

test('installer creates a daily 03:30 LaunchAgent with no credentials in plist', () => {
  const home = mkdtempSync(join(tmpdir(), 'aipro-parity-install-'));
  try {
    const launchctl = join(home, 'launchctl');
    writeFileSync(launchctl, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HOME/launchctl.log"\n');
    chmodSync(launchctl, 0o700);
    const run = spawnSync('/bin/zsh', ['scripts/install-cloud-parity-sync.sh'], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8',
      env: { ...process.env, HOME: home, ACHONG_LAUNCHCTL: launchctl,
        AIPRO_PARITY_NODE: process.execPath },
    });
    assert.equal(run.status, 0, run.stderr);
    const plist = readFileSync(join(home, 'Library', 'LaunchAgents',
      'com.local.aipro-cloud-parity-sync.plist'), 'utf8');
    assert.match(plist, /<key>StartCalendarInterval<\/key>/);
    assert.match(plist, /<key>Hour<\/key>\s*<integer>3<\/integer>/);
    assert.match(plist, /<key>Minute<\/key>\s*<integer>30<\/integer>/);
    assert.match(plist, /cloud-parity-sync.mjs/);
    assert.equal(plist.includes('parityToken'), false);
    const commands = readFileSync(join(home, 'launchctl.log'), 'utf8');
    assert.match(commands, /bootstrap/);
    assert.match(commands, /kickstart/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
