import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { D1LicensingRepository } from './repository-d1.mjs';

class LocalStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  first() {
    return this.database.prepare(this.sql).get(...this.params) || null;
  }

  all() {
    return { results: this.database.prepare(this.sql).all(...this.params) };
  }

  run() {
    const result = this.database.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(result.changes) } };
  }

  execute() {
    if (/^\s*(SELECT|WITH)/i.test(this.sql) || /\bRETURNING\b/i.test(this.sql)) {
      const results = this.database.prepare(this.sql).all(...this.params);
      return { success: true, results, meta: { changes: results.length } };
    }
    return this.run();
  }
}

class LocalD1 {
  constructor() {
    this.database = new DatabaseSync(':memory:');
  }

  prepare(sql) {
    return new LocalStatement(this.database, sql);
  }

  async batch(statements) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map(statement => statement.execute());
      this.database.exec('COMMIT');
      return results;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

const db = new LocalD1();
db.database.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
const repository = new D1LicensingRepository(db);
const now = Date.parse('2026-08-02T00:00:00.000Z');

db.database.prepare(`
  INSERT INTO issuers (id, holder, display_name, public_key, roles_json, status, created_at)
  VALUES (?, ?, ?, ?, ?, 'active', ?)
`).run('issuer-james-001', 'james-feng', 'James Feng', 'public-key', '["invite.issue"]', new Date(now).toISOString());

assert.deepEqual(await repository.getIssuer('issuer-james-001'), {
  id: 'issuer-james-001',
  holder: 'james-feng',
  displayName: 'James Feng',
  publicKey: 'public-key',
  roles: ['invite.issue'],
  status: 'active',
});

await repository.createIssuerChallenge({
  id: 'challenge-1', issuerId: 'issuer-james-001', nonceHash: 'nonce-hash',
  createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
});
assert.equal(await repository.consumeIssuerChallenge({
  id: 'challenge-1', issuerId: 'issuer-james-001', nonceHash: 'nonce-hash', now,
}), true);
assert.equal(await repository.consumeIssuerChallenge({
  id: 'challenge-1', issuerId: 'issuer-james-001', nonceHash: 'nonce-hash', now,
}), false);

const batch = {
  id: 'batch-1', issuerId: 'issuer-james-001', invitationCount: 10,
  edition: 'Business', licenseDays: 365, customerNote: '',
  createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 86_400_000).toISOString(),
};
const invitations = Array.from({ length: 10 }, (_, index) => ({
  id: `invite-${index}`, batchId: batch.id, issuerId: batch.issuerId,
  codeHash: `${index}`.padStart(64, 'a'), lastFour: `${index}`.padStart(4, '0'),
  status: 'unused', edition: 'Business', licenseDays: 365, customerNote: '',
  createdAt: batch.createdAt, expiresAt: batch.expiresAt,
}));
assert.equal(await repository.createBatch(batch, invitations), true);
assert.equal(await repository.createBatch({ ...batch, id: 'batch-duplicate' }, invitations), false);

const preview = await repository.inspectInvitation({ codeHash: invitations[0].codeHash, now });
assert.equal(preview.id, 'invite-0');
const consumed = await repository.consumeInvitation({
  codeHash: invitations[0].codeHash,
  now,
  activation: {
    id: 'activation-1', licenseId: 'license-1',
    deviceKeyHash: `sha256:${'a'.repeat(64)}`,
    entitlementHash: 'entitlement-hash', activatedAt: new Date(now).toISOString(),
  },
});
assert.equal(consumed.status, 'activated');
assert.equal(await repository.consumeInvitation({
  codeHash: invitations[0].codeHash,
  now,
  activation: {
    id: 'activation-2', licenseId: 'license-2',
    deviceKeyHash: `sha256:${'b'.repeat(64)}`,
    entitlementHash: 'other', activatedAt: new Date(now).toISOString(),
  },
}), null);

for (let attempt = 0; attempt < 5; attempt += 1) {
  await repository.recordActivationFailure('activation-key', now);
}
assert.equal((await repository.rateLimitStatus('activation-key', now)).retryAfterMs > 0, true);
await repository.clearActivationFailures('activation-key');
assert.equal(await repository.rateLimitStatus('activation-key', now), null);

db.database.prepare(`
  INSERT INTO recovery_credentials
    (id, holder, secret_hash, generation, status, created_at)
  VALUES (?, ?, ?, 1, 'active', ?)
`).run('recovery-1', 'james-feng', 'secret-hash', new Date(now).toISOString());
assert.equal(await repository.consumeRecoveryCredential({
  id: 'recovery-1', secretHash: 'secret-hash', holder: 'james-feng', now,
  newIssuer: {
    id: 'issuer-james-002', holder: 'james-feng', displayName: 'James Feng',
    publicKey: 'new-public-key', roles: ['invite.issue', 'invite.revoke'],
    status: 'active', createdAt: new Date(now).toISOString(),
  },
  replacementRecovery: {
    id: 'recovery-2', holder: 'james-feng', secretHash: 'new-secret-hash',
    generation: 0, status: 'active', createdAt: new Date(now).toISOString(),
  },
}), true);
assert.equal((await repository.getIssuer('issuer-james-001')).status, 'revoked');
assert.equal((await repository.getIssuer('issuer-james-002')).status, 'active');
assert.equal(await repository.consumeRecoveryCredential({
  id: 'recovery-1', secretHash: 'secret-hash', holder: 'james-feng', now,
  newIssuer: {
    id: 'issuer-james-003', holder: 'james-feng', displayName: 'James Feng',
    publicKey: 'third-key', roles: [], status: 'active', createdAt: new Date(now).toISOString(),
  },
  replacementRecovery: {
    id: 'recovery-3', holder: 'james-feng', secretHash: 'third-secret',
    generation: 0, status: 'active', createdAt: new Date(now).toISOString(),
  },
}), false);

console.log('LICENSING_D1_REPOSITORY_TEST_OK');
