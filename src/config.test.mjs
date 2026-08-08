import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from './config.mjs';

assert.equal(config.semanticRepeatGuardEnabled, true);
assert.equal(config.semanticRepeatWindowMs, 30 * 60_000);
assert.equal(config.semanticRepeatMaxReplies, 2);
assert.equal(config.adaptiveDiscussionEnabled, true);
assert.equal(config.adaptiveDiscussionMaxReplies, 100);
assert.equal(config.adaptiveDiscussionLowValueLimit, 3);
assert.equal(config.adaptiveDiscussionCooldownMs, 30 * 60_000);

const directory = mkdtempSync(join(tmpdir(), 'aipro-config-'));
try {
  const example = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  for (const [field, value] of [
    ['semanticRepeatMaxReplies', 1],
    ['adaptiveDiscussionMaxReplies', 101],
    ['adaptiveDiscussionLowValueLimit', 1],
    ['adaptiveDiscussionCooldownMs', 30_000],
  ]) {
    const invalidPath = join(directory, `${field}.json`);
    writeFileSync(invalidPath, JSON.stringify({ ...example, [field]: value }));
    const result = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      "await import('./src/config.mjs')",
    ], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, DIGITAL_EMPLOYEE_CONFIG: invalidPath },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, field);
    assert.match(result.stderr, new RegExp(field));
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log('CONFIG_TEST_OK');
