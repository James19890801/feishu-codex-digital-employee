const RATE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

function inviteFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    batchId: row.batch_id,
    issuerId: row.issuer_id,
    codeHash: row.code_hash,
    lastFour: row.last_four,
    status: row.status,
    edition: row.edition,
    licenseDays: Number(row.license_days),
    customerNote: row.customer_note,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    activatedAt: row.activated_at || null,
    revokedAt: row.revoked_at || null,
  };
}

function issuerFromRow(row) {
  if (!row) return null;
  let roles = [];
  try {
    roles = JSON.parse(row.roles_json);
  } catch {
    roles = [];
  }
  return {
    id: row.id,
    holder: row.holder,
    displayName: row.display_name,
    publicKey: row.public_key,
    roles: Array.isArray(roles) ? roles : [],
    status: row.status,
  };
}

export class D1LicensingRepository {
  constructor(db) {
    if (!db?.prepare || !db?.batch) throw new TypeError('D1 database binding is required');
    this.db = db;
  }

  async getIssuer(id) {
    const row = await this.db.prepare(`
      SELECT id, holder, display_name, public_key, roles_json, status
      FROM issuers
      WHERE id = ?
    `).bind(id).first();
    return issuerFromRow(row);
  }

  async createIssuerChallenge(challenge) {
    await this.db.prepare(`
      INSERT INTO issuer_challenges
        (id, issuer_id, nonce_hash, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      challenge.id,
      challenge.issuerId,
      challenge.nonceHash,
      challenge.expiresAt,
      challenge.createdAt,
    ).run();
  }

  async consumeIssuerChallenge({ id, issuerId, nonceHash, now }) {
    const row = await this.db.prepare(`
      UPDATE issuer_challenges
      SET used_at = ?
      WHERE id = ?
        AND issuer_id = ?
        AND nonce_hash = ?
        AND used_at IS NULL
        AND expires_at >= ?
      RETURNING id
    `).bind(
      new Date(now).toISOString(), id, issuerId, nonceHash, new Date(now).toISOString(),
    ).first();
    return Boolean(row);
  }

  async createBatch(batch, invitations) {
    const statements = [
      this.db.prepare(`
        INSERT INTO invite_batches
          (id, issuer_id, invitation_count, edition, license_days, customer_note, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        batch.id, batch.issuerId, batch.invitationCount, batch.edition,
        batch.licenseDays, batch.customerNote, batch.createdAt, batch.expiresAt,
      ),
      ...invitations.map(invitation => this.db.prepare(`
        INSERT INTO invites
          (id, batch_id, issuer_id, code_hash, last_four, status, edition,
           license_days, customer_note, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        invitation.id, invitation.batchId, invitation.issuerId, invitation.codeHash,
        invitation.lastFour, invitation.status, invitation.edition, invitation.licenseDays,
        invitation.customerNote, invitation.createdAt, invitation.expiresAt,
      )),
    ];
    try {
      await this.db.batch(statements);
      return true;
    } catch (error) {
      if (/unique|constraint/i.test(String(error?.message || error))) return false;
      throw error;
    }
  }

  async inspectInvitation({ codeHash, now }) {
    const row = await this.db.prepare(`
      SELECT *
      FROM invites
      WHERE code_hash = ?
        AND status = 'unused'
        AND expires_at >= ?
    `).bind(codeHash, new Date(now).toISOString()).first();
    return inviteFromRow(row);
  }

  async consumeInvitation({ codeHash, now, activation }) {
    const invitation = await this.inspectInvitation({ codeHash, now });
    if (!invitation) return null;
    const activatedAt = new Date(now).toISOString();
    try {
      const [updated, inserted] = await this.db.batch([
        this.db.prepare(`
          UPDATE invites
          SET status = 'activated', activated_at = ?, activation_id = ?
          WHERE id = ? AND code_hash = ? AND status = 'unused' AND expires_at >= ?
          RETURNING *
        `).bind(activatedAt, activation.id, invitation.id, codeHash, activatedAt),
        this.db.prepare(`
          INSERT INTO activations
            (id, invitation_id, license_id, device_key_hash, entitlement_hash, activated_at)
          SELECT ?, id, ?, ?, ?, ?
          FROM invites
          WHERE id = ? AND activation_id = ? AND status = 'activated'
        `).bind(
          activation.id,
          activation.licenseId,
          activation.deviceKeyHash,
          activation.entitlementHash,
          activation.activatedAt,
          invitation.id,
          activation.id,
        ),
      ]);
      const row = updated.results?.[0] || null;
      if (!row || Number(inserted.meta?.changes || 0) !== 1) return null;
      return inviteFromRow(row);
    } catch (error) {
      if (/unique|constraint/i.test(String(error?.message || error))) return null;
      throw error;
    }
  }

  async revokeInvitation({ issuerId, invitationId, now }) {
    const result = await this.db.prepare(`
      UPDATE invites
      SET status = 'revoked', revoked_at = ?
      WHERE id = ? AND issuer_id = ? AND status = 'unused'
    `).bind(new Date(now).toISOString(), invitationId, issuerId).run();
    return Number(result.meta?.changes || 0) === 1;
  }

  async rateLimitStatus(key, now) {
    const row = await this.db.prepare(`
      SELECT cooldown_until
      FROM rate_limits
      WHERE activation_key_hash = ?
    `).bind(key).first();
    if (!row?.cooldown_until) return null;
    const cooldownUntil = Date.parse(row.cooldown_until);
    return cooldownUntil > now ? { retryAfterMs: cooldownUntil - now } : null;
  }

  async recordActivationFailure(key, now) {
    const row = await this.db.prepare(`
      SELECT failure_count, window_started_at
      FROM rate_limits
      WHERE activation_key_hash = ?
    `).bind(key).first();
    const stale = !row || now - Date.parse(row.window_started_at) >= RATE_WINDOW_MS;
    const count = stale ? 1 : Number(row.failure_count || 0) + 1;
    const windowStartedAt = stale ? now : Date.parse(row.window_started_at);
    const cooldownUntil = count >= MAX_FAILURES
      ? new Date(windowStartedAt + RATE_WINDOW_MS).toISOString()
      : null;
    await this.db.prepare(`
      INSERT INTO rate_limits
        (activation_key_hash, failure_count, window_started_at, cooldown_until, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(activation_key_hash) DO UPDATE SET
        failure_count = excluded.failure_count,
        window_started_at = excluded.window_started_at,
        cooldown_until = excluded.cooldown_until,
        updated_at = excluded.updated_at
    `).bind(
      key,
      count,
      new Date(windowStartedAt).toISOString(),
      cooldownUntil,
      new Date(now).toISOString(),
    ).run();
    return { count, windowStart: windowStartedAt, cooldownUntil };
  }

  async clearActivationFailures(key) {
    await this.db.prepare('DELETE FROM rate_limits WHERE activation_key_hash = ?').bind(key).run();
  }

  async consumeRecoveryCredential({
    id,
    secretHash,
    holder,
    newIssuer,
    replacementRecovery,
    now,
  }) {
    const consumedAt = new Date(now).toISOString();
    try {
      const results = await this.db.batch([
        this.db.prepare(`
          UPDATE recovery_credentials
          SET status = 'consumed', consumed_at = ?, replaced_by = ?
          WHERE id = ? AND holder = ? AND secret_hash = ? AND status = 'active'
          RETURNING generation
        `).bind(consumedAt, replacementRecovery.id, id, holder, secretHash),
        this.db.prepare(`
          UPDATE issuers
          SET status = 'revoked', revoked_at = ?, replaced_by = ?
          WHERE holder = ? AND status = 'active'
            AND EXISTS (
              SELECT 1 FROM recovery_credentials
              WHERE id = ? AND holder = ? AND status = 'consumed'
                AND consumed_at = ? AND replaced_by = ?
            )
        `).bind(
          consumedAt, newIssuer.id, holder,
          id, holder, consumedAt, replacementRecovery.id,
        ),
        this.db.prepare(`
          INSERT INTO issuers
            (id, holder, display_name, public_key, roles_json, status, created_at)
          SELECT ?, ?, ?, ?, ?, 'active', ?
          WHERE EXISTS (
            SELECT 1 FROM recovery_credentials
            WHERE id = ? AND holder = ? AND status = 'consumed'
              AND consumed_at = ? AND replaced_by = ?
          )
        `).bind(
          newIssuer.id,
          holder,
          newIssuer.displayName,
          newIssuer.publicKey,
          JSON.stringify(newIssuer.roles),
          newIssuer.createdAt,
          id,
          holder,
          consumedAt,
          replacementRecovery.id,
        ),
        this.db.prepare(`
          INSERT INTO recovery_credentials
            (id, holder, secret_hash, generation, status, created_at)
          SELECT ?, ?, ?, generation + 1, 'active', ?
          FROM recovery_credentials
          WHERE id = ? AND holder = ? AND status = 'consumed'
            AND consumed_at = ? AND replaced_by = ?
        `).bind(
          replacementRecovery.id,
          holder,
          replacementRecovery.secretHash,
          replacementRecovery.createdAt,
          id,
          holder,
          consumedAt,
          replacementRecovery.id,
        ),
      ]);
      return Boolean(results[0].results?.length
        && Number(results[2].meta?.changes || 0) === 1
        && Number(results[3].meta?.changes || 0) === 1);
    } catch (error) {
      if (/unique|constraint/i.test(String(error?.message || error))) return false;
      throw error;
    }
  }
}
