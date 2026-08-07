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
}
