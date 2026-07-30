import { DatabaseSync, backup } from 'node:sqlite';
import {
  chmod,
  mkdir,
  readdir,
  rm,
  stat,
} from 'node:fs/promises';
import { join } from 'node:path';

function backupStamp(now) {
  return now.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

async function removeSidecars(path) {
  await Promise.all([
    rm(`${path}-shm`, { force: true }),
    rm(`${path}-wal`, { force: true }),
  ]);
}

export async function createVerifiedDatabaseBackup({
  db,
  backupDir,
  now = new Date(),
  retain = 14,
}) {
  if (!db || !backupDir) throw new Error('Database backup requires a database and directory');
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const path = join(backupDir, `agent-state-${backupStamp(now)}.sqlite`);
  try {
    await backup(db, path);
    await chmod(path, 0o600);
    const verification = new DatabaseSync(path, { readOnly: true });
    let integrity;
    try {
      integrity = verification.prepare('PRAGMA quick_check').get()?.quick_check || 'unknown';
    } finally {
      verification.close();
      await removeSidecars(path);
    }
    if (integrity !== 'ok') {
      throw new Error(`Database backup integrity check failed: ${integrity}`);
    }
    const files = (await readdir(backupDir))
      .filter(name => /^agent-state-\d{8}T\d{6}Z\.sqlite$/.test(name))
      .sort()
      .reverse();
    const keep = Math.max(2, Math.min(100, Number(retain) || 14));
    await Promise.all(files.slice(keep).flatMap(name => {
      const expiredPath = join(backupDir, name);
      return [
        rm(expiredPath, { force: true }),
        removeSidecars(expiredPath),
      ];
    }));
    const info = await stat(path);
    return {
      path,
      integrity,
      bytes: info.size,
      retained: Math.min(files.length, keep),
    };
  } catch (error) {
    await rm(path, { force: true }).catch(() => {});
    await removeSidecars(path).catch(() => {});
    throw error;
  }
}
