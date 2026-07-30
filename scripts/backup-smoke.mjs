import { DatabaseSync } from 'node:sqlite';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const backupDir = join(root, 'data', 'database-backups');
const files = (await readdir(backupDir))
  .filter(name => /^agent-state-\d{8}T\d{6}Z\.sqlite$/.test(name))
  .sort()
  .reverse();
if (!files.length) throw new Error('No state database backup is available');
const path = join(backupDir, files[0]);
const info = await stat(path);
if (Date.now() - info.mtimeMs > 12 * 60 * 60_000) {
  throw new Error('The latest state database backup is stale');
}
const db = new DatabaseSync(path, { readOnly: true });
let integrity;
let inbound;
let mutations;
try {
  integrity = db.prepare('PRAGMA quick_check').get()?.quick_check || 'unknown';
  inbound = Number(db.prepare('SELECT COUNT(*) count FROM inbound_message').get()?.count || 0);
  mutations = Number(db.prepare('SELECT COUNT(*) count FROM mutation_execution').get()?.count || 0);
} finally {
  db.close();
  await Promise.all([
    rm(`${path}-shm`, { force: true }),
    rm(`${path}-wal`, { force: true }),
  ]);
}
if (integrity !== 'ok') throw new Error(`Backup integrity failed: ${integrity}`);
console.log(JSON.stringify({
  healthy: true,
  integrity,
  bytes: info.size,
  ageMs: Math.max(0, Date.now() - info.mtimeMs),
  retained: files.length,
  inbound,
  mutations,
}));
