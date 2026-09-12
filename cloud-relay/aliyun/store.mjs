import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const EVENT_ID = /^[a-f0-9]{64}$/;
const ARTIFACT_KEY = /^[A-Za-z0-9_-]{24,128}$/;

function boundedInteger(value, fallback, minimum, maximum) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= minimum && numeric <= maximum ? numeric : fallback;
}

export class SqliteRelayStore {
  constructor({ databasePath, artifactDirectory, maxQueueCount = 10_000, maxQueueBytes = 256 * 1024 * 1024 }) {
    if (!path.isAbsolute(databasePath) || !path.isAbsolute(artifactDirectory)) {
      throw new Error('Relay storage paths must be absolute');
    }
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
    this.artifactDirectory = artifactDirectory;
    this.maxQueueCount = maxQueueCount;
    this.maxQueueBytes = maxQueueBytes;
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        digest TEXT PRIMARY KEY, body TEXT NOT NULL, created_at INTEGER NOT NULL,
        lease_until INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS events_lease_order ON events (lease_until, created_at);
      CREATE TABLE IF NOT EXISTS artifacts (
        key TEXT PRIMARY KEY, file_name TEXT NOT NULL, content_type TEXT NOT NULL,
        expires_at INTEGER NOT NULL, size INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS artifacts_expiry ON artifacts (expires_at);
    `);
  }

  close() { this.db.close(); }

  transaction(operation) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async enqueue({ digest, body, createdAt }) {
    if (!EVENT_ID.test(String(digest)) || typeof body !== 'string' || !body
      || Buffer.byteLength(body) > 1024 * 1024 || !Number.isFinite(createdAt)) {
      throw new Error('invalid_event');
    }
    return this.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM events WHERE digest = ?').get(digest)) {
        return { accepted: true, duplicate: true };
      }
      const size = this.db.prepare('SELECT count(*) AS count, coalesce(sum(length(cast(body AS blob))), 0) AS bytes FROM events').get();
      if (size.count >= this.maxQueueCount || size.bytes + Buffer.byteLength(body) > this.maxQueueBytes) {
        throw new Error('queue_full');
      }
      this.db.prepare('INSERT INTO events (digest, body, created_at) VALUES (?, ?, ?)').run(digest, body, Math.floor(createdAt));
      return { accepted: true, duplicate: false };
    });
  }

  async lease(input = {}) {
    const now = Number(input.now) || Date.now();
    const leaseMs = boundedInteger(input.leaseMs, 30_000, 5_000, 300_000);
    const limit = boundedInteger(input.limit, 10, 1, 50);
    return this.transaction(() => {
      const rows = this.db.prepare(`
        SELECT digest, body, created_at, attempts FROM events
        WHERE lease_until <= ? ORDER BY created_at, digest LIMIT ?
      `).all(now, limit);
      const update = this.db.prepare('UPDATE events SET lease_until = ?, attempts = attempts + 1 WHERE digest = ?');
      for (const row of rows) update.run(now + leaseMs, row.digest);
      return { events: rows.map(row => ({
        id: row.digest, body: row.body, createdAt: row.created_at,
        leaseUntil: now + leaseMs, attempts: row.attempts + 1,
      })) };
    });
  }

  async ack(input = {}) {
    const ids = [...new Set(Array.isArray(input.ids) ? input.ids.map(String) : [])]
      .filter(id => EVENT_ID.test(id)).slice(0, 50);
    return this.transaction(() => {
      const remove = this.db.prepare('DELETE FROM events WHERE digest = ?');
      let acked = 0;
      for (const id of ids) acked += Number(remove.run(id).changes);
      return { acked };
    });
  }

  async status(input = {}) {
    const now = Number(input.now) || Date.now();
    const counts = this.db.prepare(`
      SELECT count(*) AS total,
        coalesce(sum(CASE WHEN lease_until > ? THEN 1 ELSE 0 END), 0) AS leased
      FROM events
    `).get(now);
    return { pending: counts.total - counts.leased, leased: counts.leased, total: counts.total };
  }

  async putArtifact(key, { bytes, expiresAt, fileName, contentType }) {
    if (!ARTIFACT_KEY.test(String(key)) || !Buffer.isBuffer(bytes) || !bytes.length
      || bytes.length > 25 * 1024 * 1024 || !Number.isFinite(expiresAt)) {
      throw new Error('invalid_artifact');
    }
    const target = path.join(this.artifactDirectory, key);
    const temporary = path.join(this.artifactDirectory, `.tmp-${randomUUID()}`);
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    try {
      await rename(temporary, target);
      this.db.prepare(`
        INSERT INTO artifacts (key, file_name, content_type, expires_at, size)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET file_name=excluded.file_name,
          content_type=excluded.content_type, expires_at=excluded.expires_at, size=excluded.size
      `).run(key, String(fileName).slice(0, 180), String(contentType).slice(0, 200), Math.floor(expiresAt), bytes.length);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }

  async getArtifact(key) {
    if (!ARTIFACT_KEY.test(String(key))) return null;
    const row = this.db.prepare('SELECT file_name, content_type, expires_at FROM artifacts WHERE key = ?').get(key);
    if (!row) return null;
    return {
      bytes: await readFile(path.join(this.artifactDirectory, key)),
      expiresAt: row.expires_at,
      fileName: row.file_name,
      contentType: row.content_type,
    };
  }

  async cleanupArtifacts(now = Date.now()) {
    const rows = this.db.prepare('SELECT key FROM artifacts WHERE expires_at <= ?').all(now);
    for (const row of rows) {
      await unlink(path.join(this.artifactDirectory, row.key)).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      this.db.prepare('DELETE FROM artifacts WHERE key = ?').run(row.key);
    }
    return { removed: rows.length };
  }
}
