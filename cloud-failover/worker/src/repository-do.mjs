const DEFAULT_STATE = {
  state: 'LOCAL_PRIMARY', generation: 0, lastHeartbeatAt: null,
  serviceStartId: '', recoveryCount: 0, containerReady: false,
  inFlight: 0, lastErrorCode: '', drainStartedAt: null,
};

export class DurableObjectFailoverRepository {
  constructor(storage) {
    if (!storage) throw new TypeError('Durable Object storage is required');
    this.storage = storage;
    storage.sql?.exec?.(`CREATE TABLE IF NOT EXISTS failover_claims (
      claim_key TEXT PRIMARY KEY, generation INTEGER NOT NULL, digest TEXT NOT NULL,
      claimed_at INTEGER NOT NULL, completed_at INTEGER, outcome_code TEXT
    )`);
    storage.sql?.exec?.(`CREATE TABLE IF NOT EXISTS replay_nonces (
      nonce_key TEXT PRIMARY KEY, expires_at INTEGER NOT NULL
    )`);
    storage.sql?.exec?.(`CREATE TABLE IF NOT EXISTS cloud_handoffs (
      handoff_id TEXT PRIMARY KEY, digest TEXT NOT NULL, state TEXT NOT NULL,
      claimed_at INTEGER NOT NULL, completed_at INTEGER, result_json TEXT
    )`);
  }

  async read() {
    return structuredClone(await this.storage.get('coordinator_state') || DEFAULT_STATE);
  }

  async write(value) {
    await this.storage.put('coordinator_state', structuredClone(value));
  }

  async claim(key, claim) {
    if (this.storage.sql?.exec) {
      const cursor = this.storage.sql.exec(
        'INSERT OR IGNORE INTO failover_claims (claim_key, generation, digest, claimed_at) VALUES (?, ?, ?, ?) RETURNING claim_key',
        key, Number(claim.generation), key.split(':').at(-1), Number(claim.at),
      );
      return [...cursor].length === 1;
    }
    const storageKey = `claim:${key}`;
    if (await this.storage.get(storageKey)) return false;
    await this.storage.put(storageKey, claim);
    return true;
  }

  async complete(key, outcome) {
    if (this.storage.sql?.exec) {
      const cursor = this.storage.sql.exec(
        'UPDATE failover_claims SET completed_at = ?, outcome_code = ? WHERE claim_key = ? AND completed_at IS NULL RETURNING claim_key',
        Number(outcome.completedAt), String(outcome.outcomeCode || '').slice(0, 64), key,
      );
      return [...cursor].length === 1;
    }
    const storageKey = `claim:${key}`;
    const claim = await this.storage.get(storageKey);
    if (!claim || claim.completedAt) return false;
    await this.storage.put(storageKey, { ...claim, ...outcome });
    return true;
  }

  async use(node, nonce, expiresAt, now) {
    const key = `${node}:${nonce}`;
    if (this.storage.sql?.exec) {
      this.storage.sql.exec('DELETE FROM replay_nonces WHERE expires_at <= ?', Number(now));
      const cursor = this.storage.sql.exec(
        'INSERT OR IGNORE INTO replay_nonces (nonce_key, expires_at) VALUES (?, ?) RETURNING nonce_key',
        key, Number(expiresAt),
      );
      return [...cursor].length === 1;
    }
    const storageKey = `nonce:${key}`;
    if (await this.storage.get(storageKey)) return false;
    await this.storage.put(storageKey, expiresAt, { expirationTtl: 181 });
    return true;
  }

  async beginHandoff(id, digest, at, maxAgeMs = 15 * 60_000) {
    if (this.storage.sql?.exec) {
      this.storage.sql.exec('DELETE FROM cloud_handoffs WHERE claimed_at < ?', Number(at) - maxAgeMs);
      const inserted = [...this.storage.sql.exec(
        "INSERT OR IGNORE INTO cloud_handoffs (handoff_id, digest, state, claimed_at) VALUES (?, ?, 'in_progress', ?) RETURNING handoff_id",
        String(id), String(digest), Number(at),
      )].length === 1;
      if (inserted) return { accepted: true, record: { state: 'in_progress', digest: String(digest) } };
      const record = [...this.storage.sql.exec(
        'SELECT digest, state, result_json FROM cloud_handoffs WHERE handoff_id = ?', String(id),
      )][0];
      return {
        accepted: false,
        record: record ? {
          digest: String(record.digest),
          state: String(record.state),
          result: record.result_json ? JSON.parse(String(record.result_json)) : null,
        } : null,
      };
    }
    const key = `handoff:${id}`;
    const current = await this.storage.get(key);
    if (current && Number(current.claimedAt || 0) >= Number(at) - maxAgeMs) {
      return { accepted: false, record: current };
    }
    const record = { state: 'in_progress', digest: String(digest), claimedAt: Number(at) };
    await this.storage.put(key, record);
    return { accepted: true, record };
  }

  async completeHandoff(id, result, at) {
    if (this.storage.sql?.exec) {
      this.storage.sql.exec(
        "UPDATE cloud_handoffs SET state = 'completed', completed_at = ?, result_json = ? WHERE handoff_id = ?",
        Number(at), JSON.stringify(result), String(id),
      );
      return;
    }
    const key = `handoff:${id}`;
    const current = await this.storage.get(key);
    if (current) await this.storage.put(key, {
      ...current, state: 'completed', completedAt: Number(at), result: structuredClone(result),
    });
  }

  async failHandoff(id) {
    if (this.storage.sql?.exec) {
      this.storage.sql.exec('DELETE FROM cloud_handoffs WHERE handoff_id = ?', String(id));
      return;
    }
    await this.storage.delete(`handoff:${id}`);
  }

  async pruneHandoffs(now, maxAgeMs = 15 * 60_000) {
    if (this.storage.sql?.exec) {
      this.storage.sql.exec('DELETE FROM cloud_handoffs WHERE claimed_at < ?', Number(now) - maxAgeMs);
    }
  }
}
