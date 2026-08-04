const TEN_DIGITS = /^\d{10}$/;
const DEVICE_KEY_HASH = /^sha256:[a-f0-9]{64}$/;
const DEFAULT_RATE_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_MAX_FAILURES = 5;

export class DomainError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.retryAfterSeconds = Number(options.retryAfterSeconds || 0);
  }
}

function invalidInvitation() {
  return new DomainError('invalid_invitation', 'Invitation code cannot be used.');
}

function randomTenDigitCode(randomValues) {
  let code = '';
  while (code.length < 10) {
    const values = new Uint8Array(16);
    randomValues(values);
    for (const value of values) {
      if (value >= 250) continue;
      code += String(value % 10);
      if (code.length === 10) break;
    }
  }
  return code;
}

function addDays(timestamp, days) {
  return timestamp + (days * 24 * 60 * 60 * 1000);
}

function iso(timestamp) {
  return new Date(timestamp).toISOString();
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function positiveInteger(value, fallback, { min, max, label }) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new DomainError('invalid_request', `${label} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}

export class InMemoryInvitationRepository {
  constructor() {
    this.batches = new Map();
    this.invites = new Map();
    this.codeHashIndex = new Map();
    this.activations = new Map();
    this.rateLimits = new Map();
  }

  async createBatch(batch, invitations) {
    if (invitations.some(invitation => this.codeHashIndex.has(invitation.codeHash))) {
      return false;
    }
    this.batches.set(batch.id, structuredClone(batch));
    for (const invitation of invitations) {
      this.invites.set(invitation.id, structuredClone(invitation));
      this.codeHashIndex.set(invitation.codeHash, invitation.id);
    }
    return true;
  }

  async consumeInvitation({ codeHash, now, activation }) {
    const id = this.codeHashIndex.get(codeHash);
    const invitation = id ? this.invites.get(id) : null;
    if (!invitation
      || invitation.status !== 'unused'
      || Date.parse(invitation.expiresAt) < now) return null;
    invitation.status = 'activated';
    invitation.activatedAt = iso(now);
    invitation.activationId = activation.id;
    this.activations.set(activation.id, structuredClone(activation));
    return structuredClone(invitation);
  }

  async inspectInvitation({ codeHash, now }) {
    const id = this.codeHashIndex.get(codeHash);
    const invitation = id ? this.invites.get(id) : null;
    if (!invitation
      || invitation.status !== 'unused'
      || Date.parse(invitation.expiresAt) < now) return null;
    return structuredClone(invitation);
  }

  async revokeInvitation({ issuerId, invitationId, now }) {
    const invitation = this.invites.get(invitationId);
    if (!invitation || invitation.issuerId !== issuerId || invitation.status !== 'unused') {
      return false;
    }
    invitation.status = 'revoked';
    invitation.revokedAt = iso(now);
    return true;
  }

  async rateLimitStatus(key, now) {
    const entry = this.rateLimits.get(key);
    if (!entry || entry.cooldownUntil <= now) return null;
    return { retryAfterMs: entry.cooldownUntil - now };
  }

  async recordActivationFailure(key, now, {
    windowMs = DEFAULT_RATE_WINDOW_MS,
    maxFailures = DEFAULT_MAX_FAILURES,
  } = {}) {
    const existing = this.rateLimits.get(key);
    const entry = !existing || now - existing.windowStart >= windowMs
      ? { count: 0, windowStart: now, cooldownUntil: 0 }
      : existing;
    entry.count += 1;
    if (entry.count >= maxFailures) entry.cooldownUntil = entry.windowStart + windowMs;
    this.rateLimits.set(key, entry);
    return structuredClone(entry);
  }

  async clearActivationFailures(key) {
    this.rateLimits.delete(key);
  }

  findByLastFour(lastFour) {
    return [...this.invites.values()].find(invitation => invitation.lastFour === lastFour);
  }
}

export class InvitationService {
  constructor({
    repository,
    pepper,
    issueEntitlement,
    now = () => Date.now(),
    randomId = prefix => `${prefix}_${crypto.randomUUID()}`,
    randomValues = values => crypto.getRandomValues(values),
  }) {
    if (!repository) throw new TypeError('repository is required');
    if (typeof pepper !== 'string' || pepper.length < 16) throw new TypeError('pepper is required');
    if (typeof issueEntitlement !== 'function') throw new TypeError('issueEntitlement is required');
    this.repository = repository;
    this.pepper = pepper;
    this.issueEntitlement = issueEntitlement;
    this.now = now;
    this.randomId = randomId;
    this.randomValues = randomValues;
    this.hmacKey = null;
  }

  async codeHash(code) {
    if (!this.hmacKey) {
      this.hmacKey = crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(this.pepper),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
    }
    const key = await this.hmacKey;
    const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(code));
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  }

  async generateBatch({
    issuerId,
    count = 10,
    invitationDays = 30,
    licenseDays = 365,
    customerNote = '',
    edition = 'Business',
  } = {}) {
    if (count !== 10) throw new DomainError('invalid_request', 'Each batch must contain exactly 10 invitations.');
    if (typeof issuerId !== 'string' || !issuerId.trim()) {
      throw new DomainError('invalid_request', 'issuerId is required.');
    }
    if (typeof customerNote !== 'string' || customerNote.length > 240) {
      throw new DomainError('invalid_request', 'customerNote is too long.');
    }
    const activationDays = positiveInteger(invitationDays, 30, {
      min: 1, max: 365, label: 'invitationDays',
    });
    const entitlementDays = positiveInteger(licenseDays, 365, {
      min: 1, max: 3650, label: 'licenseDays',
    });
    const timestamp = this.now();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const batchId = this.randomId('batch');
      const codes = new Set();
      while (codes.size < 10) codes.add(randomTenDigitCode(this.randomValues));
      const invitations = await Promise.all([...codes].map(async code => ({
        id: this.randomId('invite'),
        batchId,
        issuerId,
        codeHash: await this.codeHash(code),
        lastFour: code.slice(-4),
        status: 'unused',
        edition,
        licenseDays: entitlementDays,
        customerNote,
        createdAt: iso(timestamp),
        expiresAt: iso(addDays(timestamp, activationDays)),
      })));
      const batch = {
        id: batchId,
        issuerId,
        invitationCount: 10,
        edition,
        licenseDays: entitlementDays,
        customerNote,
        createdAt: iso(timestamp),
        expiresAt: iso(addDays(timestamp, activationDays)),
      };
      if (await this.repository.createBatch(batch, invitations)) {
        return { ...batch, codes: [...codes] };
      }
    }
    throw new DomainError('generation_failed', 'Could not generate a unique invitation batch.');
  }

  async activate({ code, deviceKeyHash, activationKey } = {}) {
    const timestamp = this.now();
    if (typeof activationKey !== 'string' || !activationKey || activationKey.length > 160) {
      throw invalidInvitation();
    }
    const limited = await this.repository.rateLimitStatus(activationKey, timestamp);
    if (limited) {
      throw new DomainError('rate_limited', 'Try again later.', {
        retryAfterSeconds: Math.max(1, Math.ceil(limited.retryAfterMs / 1000)),
      });
    }
    if (!TEN_DIGITS.test(String(code || '')) || !DEVICE_KEY_HASH.test(String(deviceKeyHash || ''))) {
      await this.repository.recordActivationFailure(activationKey, timestamp);
      throw invalidInvitation();
    }
    const codeHash = await this.codeHash(code);
    const licenseId = this.randomId('license');
    const activationId = this.randomId('activation');
    const invitationPreview = await this.repository.inspectInvitation({ codeHash, now: timestamp });
    if (!invitationPreview) {
      await this.repository.recordActivationFailure(activationKey, timestamp);
      throw invalidInvitation();
    }
    const license = {
      version: 1,
      product: 'James',
      licenseId,
      edition: invitationPreview.edition,
      issuerId: invitationPreview.issuerId,
      deviceKeyHash,
      notBefore: iso(timestamp),
      expiresAt: iso(addDays(timestamp, invitationPreview.licenseDays)),
    };
    const issued = await this.issueEntitlement(license);
    const activation = {
      id: activationId,
      licenseId,
      deviceKeyHash,
      entitlementHash: await sha256Hex(issued.token),
      activatedAt: iso(timestamp),
    };
    const consumed = await this.repository.consumeInvitation({ codeHash, now: timestamp, activation });
    if (!consumed) {
      await this.repository.recordActivationFailure(activationKey, timestamp);
      throw invalidInvitation();
    }
    await this.repository.clearActivationFailures(activationKey);
    return { entitlement: issued.token, license };
  }

  async revokeInvitation({ issuerId, invitationId } = {}) {
    if (typeof issuerId !== 'string' || typeof invitationId !== 'string') {
      throw new DomainError('invalid_request', 'Invitation cannot be revoked.');
    }
    const revoked = await this.repository.revokeInvitation({
      issuerId,
      invitationId,
      now: this.now(),
    });
    if (!revoked) throw new DomainError('not_found', 'Invitation cannot be revoked.');
    return { revoked: true };
  }
}
