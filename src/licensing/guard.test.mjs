import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  generateSigningKeyPair,
  publicKeyFingerprint,
  signEnvelope,
} from './crypto.mjs';
import { evaluateLicenseGuard, runGuardedStartup } from './guard.mjs';

const authority = generateSigningKeyPair();
const device = generateSigningKeyPair();
const deviceKeyHash = publicKeyFingerprint(device.publicKey);
const now = new Date('2026-08-02T12:00:00.000Z');
const validToken = signEnvelope({
  version: 1,
  product: 'AIPRO',
  licenseId: 'license-founder-james',
  edition: 'Founder',
  issuerId: 'issuer-james',
  deviceKeyHash,
  notBefore: '2026-08-01T00:00:00.000Z',
  expiresAt: '2126-08-01T00:00:00.000Z',
}, authority.privateKey);

function fakeStore({ token = validToken, lastSeenAt = null } = {}) {
  return {
    savedClock: null,
    async ensureDeviceIdentity() { return { ...device, keyHash: deviceKeyHash }; },
    async loadEntitlement() { return token; },
    async loadClockState() { return lastSeenAt ? { lastSeenAt } : null; },
    async saveClockState(value) { this.savedClock = value; },
  };
}

const store = fakeStore();
const allowed = await evaluateLicenseGuard({
  enforced: true,
  store,
  publicKey: authority.publicKey,
  product: 'AIPRO',
  now,
});
assert.equal(allowed.allowed, true);
assert.equal(allowed.edition, 'Founder');
assert.equal(allowed.issuerAuthorized, true);
assert.equal(allowed.licenseId, 'license-founder-james');
assert.equal(store.savedClock.lastSeenAt, now.toISOString());
assert.equal('token' in allowed, false);

const unenforced = await evaluateLicenseGuard({ enforced: false });
assert.deepEqual(unenforced, {
  allowed: true,
  enforced: false,
  edition: 'Development',
  issuerAuthorized: false,
});

const missing = await evaluateLicenseGuard({
  enforced: true,
  store: fakeStore({ token: null }),
  publicKey: authority.publicKey,
  product: 'AIPRO',
  now,
});
assert.equal(missing.allowed, false);
assert.equal(missing.reason, 'activation_required');

const wrongDeviceToken = signEnvelope({
  version: 1,
  product: 'AIPRO',
  licenseId: 'license-other',
  edition: 'Business',
  deviceKeyHash: `sha256:${'b'.repeat(64)}`,
  notBefore: '2026-08-01T00:00:00.000Z',
  expiresAt: '2027-08-01T00:00:00.000Z',
}, authority.privateKey);
const wrongDevice = await evaluateLicenseGuard({
  enforced: true,
  store: fakeStore({ token: wrongDeviceToken }),
  publicKey: authority.publicKey,
  product: 'AIPRO',
  now,
});
assert.equal(wrongDevice.allowed, false);
assert.equal(wrongDevice.reason, 'wrong_device');

const tampered = await evaluateLicenseGuard({
  enforced: true,
  store: fakeStore({ token: `${validToken.slice(0, -1)}x` }),
  publicKey: authority.publicKey,
  product: 'AIPRO',
  now,
});
assert.equal(tampered.allowed, false);
assert.equal(tampered.reason, 'invalid_entitlement');

const rollback = await evaluateLicenseGuard({
  enforced: true,
  store: fakeStore({ lastSeenAt: '2026-08-03T12:00:00.000Z' }),
  publicKey: authority.publicKey,
  product: 'AIPRO',
  now,
});
assert.equal(rollback.allowed, false);
assert.equal(rollback.reason, 'clock_rollback');

const events = [];
const blocked = await runGuardedStartup({
  guard: async () => ({ allowed: false, reason: 'activation_required' }),
  initialize: async () => events.push('initialized'),
  onBlocked: async decision => events.push(`blocked:${decision.reason}`),
});
assert.equal(blocked.started, false);
assert.deepEqual(events, ['blocked:activation_required']);

const started = await runGuardedStartup({
  guard: async () => ({ allowed: true, edition: 'Founder' }),
  initialize: async decision => events.push(`initialized:${decision.edition}`),
});
assert.equal(started.started, true);
assert.equal(events.at(-1), 'initialized:Founder');

const indexSource = await readFile(new URL('../index.mjs', import.meta.url), 'utf8');
const guardPosition = indexSource.indexOf('CORE_LICENSE_GUARD');
const statePosition = indexSource.indexOf('new AgentState');
const runtimePosition = indexSource.indexOf('const AI_RUNTIMES');
assert.equal(guardPosition > 0, true);
assert.equal(guardPosition < statePosition, true);
assert.equal(guardPosition < runtimePosition, true);

console.log('LICENSING_GUARD_TEST_OK');
