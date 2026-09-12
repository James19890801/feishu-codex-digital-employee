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
      CREATE TABLE IF NOT EXISTS failover_leadership (
        id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL, owner TEXT NOT NULL,
        generation INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL,
        recovery_count INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS failover_transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL,
        state TEXT NOT NULL, owner TEXT NOT NULL, generation INTEGER NOT NULL,
        observed_at INTEGER NOT NULL, last_local_heartbeat_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS failover_claims (
        claim_key TEXT PRIMARY KEY, channel TEXT NOT NULL, source_event_id TEXT NOT NULL,
        worker TEXT NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL,
        outcome TEXT, claimed_at INTEGER NOT NULL, completed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS failover_outbox (
        intent_key TEXT PRIMARY KEY, claim_key TEXT NOT NULL, generation INTEGER NOT NULL,
        status TEXT NOT NULL, provider_receipt_id TEXT, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
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

  leadershipStatus() {
    const row = this.db.prepare(`SELECT state, owner, generation, heartbeat_at
      FROM failover_leadership WHERE id = 1`).get();
    return row ? { state: row.state, owner: row.owner, generation: row.generation,
      heartbeatAt: row.heartbeat_at } : null;
  }

  leadershipTimeline({ limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('invalid_timeline_limit');
    return this.db.prepare(`SELECT event, state, owner, generation, observed_at,
      last_local_heartbeat_at FROM failover_transitions ORDER BY id DESC LIMIT ?`)
      .all(limit).reverse().map(row => ({ event: row.event, state: row.state,
        owner: row.owner, generation: row.generation, observedAt: row.observed_at,
        lastLocalHeartbeatAt: row.last_local_heartbeat_at }));
  }

  recordLeadershipTransition(event, current, now, lastLocalHeartbeatAt = current.heartbeatAt) {
    this.db.prepare(`INSERT INTO failover_transitions
      (event, state, owner, generation, observed_at, last_local_heartbeat_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(event, current.state, current.owner,
      current.generation, Math.floor(now), lastLocalHeartbeatAt);
  }

  startLocalLeadership({ now = Date.now() } = {}) {
    if (!Number.isFinite(now)) throw new Error('invalid_leadership_time');
    return this.transaction(() => {
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO failover_leadership
        (id, state, owner, generation, heartbeat_at, updated_at) VALUES (1, 'LOCAL_PRIMARY', 'mac', 1, ?, ?)`)
        .run(Math.floor(now), Math.floor(now));
      const current = this.leadershipStatus();
      if (inserted.changes) this.recordLeadershipTransition('local_started', current, now, null);
      return current;
    });
  }

  heartbeatLocal({ generation, now = Date.now() } = {}) {
    if (!Number.isFinite(now)) throw new Error('invalid_leadership_time');
    return this.transaction(() => {
      const current = this.leadershipStatus();
      if (!current || current.state !== 'LOCAL_PRIMARY' || current.owner !== 'mac'
        || current.generation !== generation || now < current.heartbeatAt) {
        return { accepted: false, ...current };
      }
      this.db.prepare(`UPDATE failover_leadership SET heartbeat_at = ?, updated_at = ? WHERE id = 1`)
        .run(Math.floor(now), Math.floor(now));
      return { accepted: true, ...this.leadershipStatus() };
    });
  }

  tryCloudTakeover({ now = Date.now(), cloudReady = false, missThresholdMs = 90_000 } = {}) {
    if (!Number.isFinite(now) || !Number.isInteger(missThresholdMs)
      || missThresholdMs < 30_000 || missThresholdMs > 600_000) {
      throw new Error('invalid_leadership_time');
    }
    return this.transaction(() => {
      const current = this.leadershipStatus();
      if (!current || current.state !== 'LOCAL_PRIMARY' || !cloudReady
        || now - current.heartbeatAt < missThresholdMs) {
        return { takenOver: false, ...(current || { state: 'DISABLED' }) };
      }
      this.db.prepare(`UPDATE failover_leadership SET state = 'CLOUD_ACTIVE', owner = 'cloud',
        generation = generation + 1, recovery_count = 0, updated_at = ? WHERE id = 1`)
        .run(Math.floor(now));
      const next = this.leadershipStatus();
      this.recordLeadershipTransition('cloud_promoted', next, now, current.heartbeatAt);
      return { takenOver: true, state: next.state, owner: next.owner,
        generation: next.generation };
    });
  }

  recoveryHeartbeat({ now = Date.now(), healthy = false } = {}) {
    if (!Number.isFinite(now)) throw new Error('invalid_leadership_time');
    return this.transaction(() => {
      const current = this.leadershipStatus();
      if (!current || current.state !== 'CLOUD_ACTIVE') return current || { state: 'DISABLED' };
      const row = this.db.prepare('SELECT recovery_count, updated_at FROM failover_leadership WHERE id = 1').get();
      if (now <= row.updated_at) return current;
      if (healthy && row.recovery_count > 0 && now - row.updated_at < 15_000) return current;
      const count = healthy ? row.recovery_count + 1 : 0;
      const state = count >= 3 ? 'DRAINING' : 'CLOUD_ACTIVE';
      this.db.prepare(`UPDATE failover_leadership SET recovery_count = ?, state = ?, updated_at = ? WHERE id = 1`)
        .run(count, state, Math.floor(now));
      const next = this.leadershipStatus();
      if (healthy && count === 1) this.recordLeadershipTransition('local_recovery_seen', next, now);
      if (state === 'DRAINING') this.recordLeadershipTransition('cloud_draining', next, now);
      return next;
    });
  }

  finishCloudDrain({ now = Date.now() } = {}) {
    if (!Number.isFinite(now)) throw new Error('invalid_leadership_time');
    return this.transaction(() => {
      const current = this.leadershipStatus();
      if (!current || current.state !== 'DRAINING') {
        return { handedBack: false, ...(current || { state: 'DISABLED' }) };
      }
      const inFlight = this.db.prepare(`SELECT count(*) AS count FROM failover_claims
        WHERE worker = 'cloud' AND generation = ? AND status = 'claimed'`).get(current.generation);
      const unsettled = this.db.prepare(`SELECT count(*) AS count FROM failover_outbox
        WHERE generation = ? AND status IN ('prepared', 'ambiguous')`).get(current.generation);
      if (inFlight.count || unsettled.count) return { handedBack: false, ...current };
      this.db.prepare(`UPDATE failover_leadership SET state = 'LOCAL_PRIMARY', owner = 'mac',
        generation = generation + 1, heartbeat_at = ?, recovery_count = 0, updated_at = ? WHERE id = 1`)
        .run(Math.floor(now), Math.floor(now));
      const next = this.leadershipStatus();
      this.recordLeadershipTransition('local_restored', next, now, current.heartbeatAt);
      return { handedBack: true, state: next.state, owner: next.owner,
        generation: next.generation };
    });
  }

  claimEvent({ worker, generation, channel, sourceEventId, now = Date.now() } = {}) {
    if (!['mac', 'cloud'].includes(worker) || !['wechat', 'dingtalk'].includes(channel)
      || typeof sourceEventId !== 'string' || !sourceEventId || sourceEventId.length > 300
      || !Number.isSafeInteger(generation) || !Number.isFinite(now)) {
      throw new Error('invalid_failover_claim');
    }
    const claimKey = sha256(`${channel}\0${sourceEventId}`);
    return this.transaction(() => {
      const current = this.leadershipStatus();
      if (!current || current.owner !== worker || current.generation !== generation
        || !['LOCAL_PRIMARY', 'CLOUD_ACTIVE'].includes(current.state)) {
        return { claimed: false, reason: 'stale_generation', claimKey };
      }
      const previous = this.db.prepare(`SELECT worker, generation, status FROM failover_claims
        WHERE claim_key = ?`).get(claimKey);
      if (previous) {
        const hasIntent = this.db.prepare(`SELECT 1 FROM failover_outbox
          WHERE claim_key = ? LIMIT 1`).get(claimKey);
        if (previous.status !== 'claimed' || previous.generation >= generation || hasIntent) {
          return { claimed: false, reason: 'duplicate', claimKey };
        }
        this.db.prepare(`UPDATE failover_claims SET worker = ?, generation = ?, claimed_at = ?
          WHERE claim_key = ?`).run(worker, generation, Math.floor(now), claimKey);
        return { claimed: true, reason: 'transferred', claimKey };
      }
      const result = this.db.prepare(`INSERT OR IGNORE INTO failover_claims
        (claim_key, channel, source_event_id, worker, generation, status, claimed_at)
        VALUES (?, ?, ?, ?, ?, 'claimed', ?)`).run(claimKey, channel, sourceEventId,
        worker, generation, Math.floor(now));
      return { claimed: result.changes === 1, reason: result.changes === 1 ? '' : 'duplicate', claimKey };
    });
  }

  prepareSend({ worker, generation, claimKey, actionKind, now = Date.now() } = {}) {
    if (!['mac', 'cloud'].includes(worker) || !Number.isSafeInteger(generation)
      || !EVENT_ID.test(String(claimKey)) || !/^[a-z0-9_-]{1,64}$/.test(String(actionKind))
      || !Number.isFinite(now)) throw new Error('invalid_failover_intent');
    const intentKey = sha256(`${claimKey}\0${actionKind}`);
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT status FROM failover_outbox WHERE intent_key = ?').get(intentKey);
      if (existing) return { intentKey, shouldSend: false, status: existing.status };
      const current = this.leadershipStatus();
      const claim = this.db.prepare(`SELECT worker, generation, status FROM failover_claims
        WHERE claim_key = ?`).get(claimKey);
      if (!current || current.owner !== worker || current.generation !== generation
        || !['LOCAL_PRIMARY', 'CLOUD_ACTIVE'].includes(current.state)
        || !claim || claim.worker !== worker || claim.generation !== generation
        || claim.status !== 'claimed') {
        return { intentKey, shouldSend: false, status: 'fenced' };
      }
      this.db.prepare(`INSERT INTO failover_outbox
        (intent_key, claim_key, generation, status, created_at, updated_at)
        VALUES (?, ?, ?, 'prepared', ?, ?)`).run(intentKey, claimKey, generation,
        Math.floor(now), Math.floor(now));
      return { intentKey, shouldSend: true, status: 'prepared' };
    });
  }

  recordSendReceipt({ intentKey, generation, status, providerReceiptId = '', now = Date.now() } = {}) {
    if (!EVENT_ID.test(String(intentKey)) || !Number.isSafeInteger(generation)
      || !['sent', 'ambiguous'].includes(status) || !Number.isFinite(now)
      || (status === 'sent' && !providerReceiptId)) throw new Error('invalid_failover_receipt');
    return this.transaction(() => {
      const current = this.db.prepare(`SELECT status, generation, provider_receipt_id
        FROM failover_outbox WHERE intent_key = ?`).get(intentKey);
      if (!current || current.generation !== generation) throw new Error('stale_failover_receipt');
      if (current.status === status && (status !== 'sent'
        || current.provider_receipt_id === providerReceiptId)) {
        return { status, duplicate: true };
      }
      if (current.status === 'sent') throw new Error('conflicting_failover_receipt');
      this.db.prepare(`UPDATE failover_outbox SET status = ?, provider_receipt_id = ?,
        updated_at = ? WHERE intent_key = ?`).run(status, providerReceiptId || null,
        Math.floor(now), intentKey);
      return { status, duplicate: false };
    });
  }

  completeClaim({ claimKey, worker, generation, outcome, now = Date.now() } = {}) {
    if (!EVENT_ID.test(String(claimKey)) || !['mac', 'cloud'].includes(worker)
      || !Number.isSafeInteger(generation) || !/^[a-z0-9_-]{1,64}$/.test(String(outcome))
      || !Number.isFinite(now)) throw new Error('invalid_failover_completion');
    return this.transaction(() => {
      const claim = this.db.prepare(`SELECT worker, generation, status FROM failover_claims
        WHERE claim_key = ?`).get(claimKey);
      if (!claim || claim.worker !== worker || claim.generation !== generation) {
        return { completed: false, reason: 'stale_generation' };
      }
      if (claim.status === 'completed') return { completed: false, reason: 'duplicate' };
      const pending = this.db.prepare(`SELECT count(*) AS count FROM failover_outbox
        WHERE claim_key = ? AND status != 'sent'`).get(claimKey);
      if (pending.count) return { completed: false, reason: 'unsettled_send' };
      if (outcome === 'replied') {
        const receipt = this.db.prepare(`SELECT 1 FROM failover_outbox
          WHERE claim_key = ? AND status = 'sent' LIMIT 1`).get(claimKey);
        if (!receipt) return { completed: false, reason: 'missing_send_receipt' };
      }
      this.db.prepare(`UPDATE failover_claims SET status = 'completed', outcome = ?,
        completed_at = ? WHERE claim_key = ?`).run(outcome, Math.floor(now), claimKey);
      return { completed: true };
    });
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
