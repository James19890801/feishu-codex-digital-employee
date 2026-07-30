import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rotateLogIfNeeded } from './log-maintenance.mjs';

const dir = mkdtempSync(join(tmpdir(), 'xiaozhao-logs-'));
try {
  const small = join(dir, 'small.log');
  writeFileSync(small, 'ok');
  assert.equal(await rotateLogIfNeeded(small, 10), false);
  assert.equal(existsSync(`${small}.1`), false);

  const large = join(dir, 'large.log');
  writeFileSync(large, '0123456789ABCDEF');
  assert.equal(await rotateLogIfNeeded(large, 10), true);
  assert.equal(readFileSync(large, 'utf8'), '');
  assert.equal(readFileSync(`${large}.1`, 'utf8'), '0123456789ABCDEF');
  console.log('LOG_MAINTENANCE_TEST_OK');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
