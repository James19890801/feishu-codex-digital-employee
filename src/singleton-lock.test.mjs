import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireSingletonLock } from './singleton-lock.mjs';

const dir = await mkdtemp(join(tmpdir(), 'digital-employee-lock-'));
const path = join(dir, 'service.lock');
try {
  const first = await acquireSingletonLock(path);
  await assert.rejects(
    acquireSingletonLock(path),
    error => error?.code === 'SERVICE_ALREADY_RUNNING',
  );
  await first.release();

  await writeFile(path, JSON.stringify({ pid: 999_999_999 }));
  const recovered = await acquireSingletonLock(path);
  await recovered.release();
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('SINGLETON_LOCK_TEST_OK');
