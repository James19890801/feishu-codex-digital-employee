import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
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

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function verifyPolicyManifest(manifest) {
  if (manifest?.version !== 1 || !manifest.sections || typeof manifest.sections !== 'object') {
    throw new Error('invalid_policy_manifest');
  }
  const sectionDigests = {};
  let totalBytes = 0;
  for (const name of ['persona', 'bible', 'instructions', 'config', 'state']) {
    const part = manifest.sections[name];
    if (!part || !Object.hasOwn(part, 'data')) throw new Error('invalid_policy_manifest');
    const encoded = canonicalJson(part.data);
    const bytes = Buffer.byteLength(encoded);
    if (bytes > 16 * 1024 * 1024 || bytes !== part.bytes || sha256(encoded) !== part.digest) {
      throw new Error('policy_section_digest_mismatch');
    }
    sectionDigests[name] = part.digest;
    totalBytes += bytes;
  }
  if (totalBytes > 24 * 1024 * 1024 || manifest.totalBytes !== totalBytes
    || manifest.digest !== sha256(canonicalJson(sectionDigests))) {
    throw new Error('policy_manifest_digest_mismatch');
  }
}

function encryptPolicy(key, data) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
}

function decryptPolicy(key, bytes) {
  const decoder = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decoder.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decoder.update(bytes.subarray(28)), decoder.final()]).toString('utf8');
}

export class SqliteRelayStore {
  constructor({ databasePath, artifactDirectory, maxQueueCount = 10_000, maxQueueBytes = 256 * 1024 * 1024,
    parityEncryptionKey }) {
    if (!path.isAbsolute(databasePath) || !path.isAbsolute(artifactDirectory)) {
      throw new Error('Relay storage paths must be absolute');
    }
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
    this.artifactDirectory = artifactDirectory;
    this.maxQueueCount = maxQueueCount;
    this.maxQueueBytes = maxQueueBytes;
    if (parityEncryptionKey !== undefined && (!Buffer.isBuffer(parityEncryptionKey)
      || parityEncryptionKey.length !== 32)) throw new Error('invalid_parity_encryption_key');
    this.parityEncryptionKey = parityEncryptionKey;
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
      CREATE TABLE IF NOT EXISTS policy_versions (
        revision INTEGER PRIMARY KEY AUTOINCREMENT, digest TEXT NOT NULL,
        ciphertext BLOB NOT NULL, applied_at INTEGER NOT NULL, source TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS policy_cursor (
        worker_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL, digest TEXT NOT NULL
      );
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

  requireParityKey() {
    if (!this.parityEncryptionKey) throw new Error('parity_unconfigured');
  }

  savePolicySnapshot({ workerId, sequence, manifest, now = Date.now() }) {
    this.requireParityKey();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(workerId))
      || !Number.isSafeInteger(sequence) || sequence < 1 || !Number.isFinite(now)) {
      throw new Error('invalid_policy_sequence');
    }
    verifyPolicyManifest(manifest);
    return this.transaction(() => {
      const cursor = this.db.prepare('SELECT sequence, digest FROM policy_cursor WHERE worker_id = ?').get(workerId);
      const current = this.db.prepare('SELECT revision, digest FROM policy_versions ORDER BY revision DESC LIMIT 1').get();
      if (cursor && sequence <= cursor.sequence) {
        if (sequence === cursor.sequence && manifest.digest === cursor.digest) {
          return { revision: current?.revision || 0, duplicate: true, digest: manifest.digest };
        }
        throw new Error('stale_policy_sequence');
      }
      if (current?.digest === manifest.digest) {
        this.db.prepare(`INSERT INTO policy_cursor (worker_id, sequence, digest) VALUES (?, ?, ?)
          ON CONFLICT(worker_id) DO UPDATE SET sequence=excluded.sequence, digest=excluded.digest`)
          .run(workerId, sequence, manifest.digest);
        return { revision: current.revision, duplicate: true, digest: manifest.digest };
      }
      const ciphertext = encryptPolicy(this.parityEncryptionKey, canonicalJson(manifest));
      const saved = this.db.prepare(`INSERT INTO policy_versions (digest, ciphertext, applied_at, source)
        VALUES (?, ?, ?, ?)`).run(manifest.digest, ciphertext, Math.floor(now), workerId);
      this.db.prepare(`INSERT INTO policy_cursor (worker_id, sequence, digest) VALUES (?, ?, ?)
        ON CONFLICT(worker_id) DO UPDATE SET sequence=excluded.sequence, digest=excluded.digest`)
        .run(workerId, sequence, manifest.digest);
      return { revision: Number(saved.lastInsertRowid), duplicate: false, digest: manifest.digest };
    });
  }

  getPolicyRevision(revision) {
    this.requireParityKey();
    const row = this.db.prepare('SELECT revision, digest, ciphertext, applied_at, source FROM policy_versions WHERE revision = ?')
      .get(revision);
    if (!row) return null;
    const manifest = JSON.parse(decryptPolicy(this.parityEncryptionKey, row.ciphertext));
    verifyPolicyManifest(manifest);
    if (manifest.digest !== row.digest) throw new Error('policy_manifest_digest_mismatch');
    return { revision: row.revision, digest: row.digest, appliedAt: row.applied_at,
      source: row.source, manifest };
  }

  getCurrentPolicy() {
    this.requireParityKey();
    const row = this.db.prepare('SELECT revision FROM policy_versions ORDER BY revision DESC LIMIT 1').get();
    return row ? this.getPolicyRevision(row.revision) : null;
  }

  getPolicyCursor(workerId) {
    this.requireParityKey();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(workerId))) return null;
    const row = this.db.prepare('SELECT sequence, digest FROM policy_cursor WHERE worker_id = ?').get(workerId);
    return row ? { sequence: row.sequence, digest: row.digest } : null;
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
