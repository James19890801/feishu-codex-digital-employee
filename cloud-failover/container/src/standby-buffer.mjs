import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const INFO = Buffer.from('aipros-standby-buffer-v1');

function deriveKey(secret, nodeId) {
  const token = String(secret || '');
  const identity = String(nodeId || '').trim();
  if (!token) throw new Error('Standby buffer secret is required');
  if (!identity) throw new Error('Standby buffer nodeId is required');
  return Buffer.from(hkdfSync('sha256', Buffer.from(token), Buffer.from(identity), INFO, 32));
}

function digestFor(message) {
  const messageId = String(message?.messageId || '').trim();
  if (!messageId) throw new Error('Standby messageId is required');
  return createHash('sha256').update(messageId).digest('hex');
}

export class StandbyMessageBuffer {
  static async open({ path, secret, nodeId, now = () => Date.now(), ttlMs = 180_000, maxRows = 100 } = {}) {
    const databasePath = String(path || '').trim();
    if (!databasePath) throw new Error('Standby buffer path is required');
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new Error('Standby buffer ttlMs must be positive');
    if (!Number.isInteger(maxRows) || maxRows <= 0) throw new Error('Standby buffer maxRows must be positive');
    await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(databasePath);
    database.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS standby_messages (
        digest TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        nonce BLOB NOT NULL,
        ciphertext BLOB NOT NULL,
        auth_tag BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS standby_messages_created_at
        ON standby_messages(created_at);
    `);
    return new StandbyMessageBuffer({ database, key: deriveKey(secret, nodeId), now, ttlMs, maxRows });
  }

  constructor({ database, key, now, ttlMs, maxRows }) {
    this.database = database;
    this.key = key;
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxRows = maxRows;
    this.closed = false;
  }

  assertOpen() {
    if (this.closed) throw new Error('Standby buffer is closed');
  }

  transaction(callback) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const value = callback();
      this.database.exec('COMMIT');
      return value;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  deleteExpired(now) {
    return Number(this.database.prepare(
      'DELETE FROM standby_messages WHERE created_at < ?',
    ).run(Number(now) - this.ttlMs).changes || 0);
  }

  encrypt(message, digest) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(digest));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(message), 'utf8'), cipher.final()]);
    return { nonce, ciphertext, authTag: cipher.getAuthTag() };
  }

  decrypt(row) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(row.nonce));
      decipher.setAAD(Buffer.from(row.digest));
      decipher.setAuthTag(Buffer.from(row.auth_tag));
      const cleartext = Buffer.concat([
        decipher.update(Buffer.from(row.ciphertext)), decipher.final(),
      ]).toString('utf8');
      return JSON.parse(cleartext);
    } catch (error) {
      throw Object.assign(new Error('Standby message decrypt or authenticate failed'), {
        code: 'standby_decrypt_failed', cause: error,
      });
    }
  }

  async put(message) {
    this.assertOpen();
    const createdAt = Number(message?.createdAt);
    const current = Number(this.now());
    if (!Number.isFinite(createdAt) || createdAt < current - this.ttlMs) return false;
    const digest = digestFor(message);
    const encrypted = this.encrypt(message, digest);
    return this.transaction(() => {
      this.deleteExpired(current);
      const result = this.database.prepare(`
        INSERT OR IGNORE INTO standby_messages
          (digest, created_at, nonce, ciphertext, auth_tag)
        VALUES (?, ?, ?, ?, ?)
      `).run(digest, createdAt, encrypted.nonce, encrypted.ciphertext, encrypted.authTag);
      const count = Number(this.database.prepare('SELECT COUNT(*) AS count FROM standby_messages').get().count);
      const excess = Math.max(0, count - this.maxRows);
      if (excess) {
        this.database.prepare(`
          DELETE FROM standby_messages WHERE rowid IN (
            SELECT rowid FROM standby_messages ORDER BY created_at ASC, rowid ASC LIMIT ?
          )
        `).run(excess);
      }
      return Number(result.changes || 0) === 1;
    });
  }

  async list() {
    this.assertOpen();
    return this.database.prepare(`
      SELECT digest, created_at, nonce, ciphertext, auth_tag
      FROM standby_messages ORDER BY created_at ASC, rowid ASC
    `).all().map(row => this.decrypt(row));
  }

  async prune(now = this.now()) {
    this.assertOpen();
    return this.transaction(() => this.deleteExpired(Number(now)));
  }

  async drain({ now = this.now(), handler } = {}) {
    this.assertOpen();
    if (typeof handler !== 'function') throw new TypeError('Standby buffer drain handler is required');
    await this.prune(now);
    const rows = this.database.prepare(`
      SELECT digest, created_at, nonce, ciphertext, auth_tag
      FROM standby_messages ORDER BY created_at ASC, rowid ASC
    `).all();
    let completed = 0;
    let failed = 0;
    for (const row of rows) {
      const message = this.decrypt(row);
      try {
        await handler(message);
      } catch {
        failed += 1;
        break;
      }
      this.transaction(() => {
        this.deleteExpired(Number(now));
        this.database.prepare('DELETE FROM standby_messages WHERE digest = ?').run(row.digest);
      });
      completed += 1;
    }
    const remaining = Number(this.database.prepare('SELECT COUNT(*) AS count FROM standby_messages').get().count);
    return { completed, failed, remaining };
  }

  async close() {
    if (this.closed) return;
    this.database.close();
    this.key.fill(0);
    this.closed = true;
  }
}
