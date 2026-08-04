import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentState } from './state.mjs';
import { createVerifiedDatabaseBackup } from './database-backup.mjs';

const dir = mkdtempSync(join(tmpdir(), 'james-backup-'));
try {
  const state = new AgentState(join(dir, 'state.sqlite'));
  state.audit('backup-test', { detail: { ok: true } });
  const backupDir = join(dir, 'backups');
  const first = await createVerifiedDatabaseBackup({
    db: state.db,
    backupDir,
    now: new Date('2026-07-31T01:00:00.000Z'),
    retain: 2,
  });
  assert.equal(first.integrity, 'ok');
  assert.equal(first.bytes > 0, true);
  assert.equal(existsSync(first.path), true);

  await createVerifiedDatabaseBackup({
    db: state.db,
    backupDir,
    now: new Date('2026-07-31T02:00:00.000Z'),
    retain: 2,
  });
  await createVerifiedDatabaseBackup({
    db: state.db,
    backupDir,
    now: new Date('2026-07-31T03:00:00.000Z'),
    retain: 2,
  });
  const directoryEntries = await readdir(backupDir);
  const files = directoryEntries.filter(name => name.endsWith('.sqlite'));
  assert.equal(files.length, 2);
  assert.equal(files.some(name => name.includes('010000')), false);
  assert.equal(directoryEntries.some(name => /-wal$|-shm$/.test(name)), false);
  state.close();
  console.log('DATABASE_BACKUP_TEST_OK');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
