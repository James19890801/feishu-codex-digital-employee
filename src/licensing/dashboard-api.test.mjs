import assert from 'node:assert/strict';

import {
  generateSigningKeyPair,
  publicKeyFingerprint,
  signEnvelope,
  verifyEnvelope,
} from './crypto.mjs';
import { LicensingDashboardApi } from './dashboard-api.mjs';

const authority = generateSigningKeyPair();
const device = generateSigningKeyPair();
const issuer = generateSigningKeyPair();
const deviceKeyHash = publicKeyFingerprint(device.publicKey);
const now = new Date('2026-08-02T12:00:00.000Z');

const founderToken = signEnvelope({
  version: 1,
  product: 'AIPRO',
  licenseId: 'license-founder-james',
  edition: 'Founder',
  issuerId: 'issuer-james',
  deviceKeyHash,
  notBefore: '2026-08-01T00:00:00.000Z',
  expiresAt: '2126-08-01T00:00:00.000Z',
}, authority.privateKey);

class FakeStore {
  constructor({ token = founderToken, includeIssuer = true } = {}) {
    this.token = token;
    this.includeIssuer = includeIssuer;
    this.clock = null;
  }
  async ensureDeviceIdentity() { return { ...device, keyHash: deviceKeyHash }; }
  async loadEntitlement() { return this.token; }
  async saveEntitlement(value) { this.token = value; }
  async loadClockState() { return this.clock; }
  async saveClockState(value) { this.clock = value; }
  async loadFounderMarker() {
    return this.includeIssuer ? { edition: 'Founder', issuerId: 'issuer-james' } : null;
  }
  async loadIssuerIdentity() {
    return this.includeIssuer ? {
      issuerId: 'issuer-james',
      displayName: 'James Feng',
      publicKey: issuer.publicKey,
      privateKey: issuer.privateKey,
    } : null;
  }
}

const generatedCodes = Array.from({ length: 10 }, (_, index) => String(1000000000 + index));
let generationRequest = null;
const remote = {
  async activate({ code }) {
    assert.equal(code, '1234567890');
    return {
      entitlement: signEnvelope({
        version: 1,
        product: 'AIPRO',
        licenseId: 'license-business',
        edition: 'Business',
        deviceKeyHash,
        notBefore: '2026-08-01T00:00:00.000Z',
        expiresAt: '2027-08-01T00:00:00.000Z',
      }, authority.privateKey),
    };
  },
  async issuerChallenge({ issuerId }) {
    assert.equal(issuerId, 'issuer-james');
    return {
      challenge: {
        id: 'challenge-123',
        nonce: 'nonce-123',
        expiresAt: '2026-08-02T12:05:00.000Z',
      },
    };
  },
  async generateInvites(value) {
    generationRequest = value;
    return {
      batch: {
        id: 'batch-123',
        codes: generatedCodes,
        createdAt: now.toISOString(),
      },
    };
  },
};

const founderStore = new FakeStore();
const api = new LicensingDashboardApi({
  store: founderStore,
  client: remote,
  publicKey: authority.publicKey,
  product: 'AIPRO',
  enforced: true,
  now: () => now,
});

const founderStatus = await api.status();
assert.deepEqual(founderStatus, {
  ok: true,
  enforced: true,
  activated: true,
  edition: 'Founder',
  expiresAt: '2126-08-01T00:00:00.000Z',
  issuer: {
    authorized: true,
    id: 'issuer-james',
    displayName: 'James Feng',
  },
});
assert.equal(JSON.stringify(founderStatus).includes(issuer.privateKey), false);
assert.equal(JSON.stringify(founderStatus).includes(founderToken), false);

const batch = await api.generate({ customerNote: 'pilot customer' });
assert.deepEqual(batch.codes, generatedCodes);
assert.equal(batch.codes.length, 10);
const proof = verifyEnvelope(generationRequest.proof, issuer.publicKey);
assert.deepEqual(proof, {
  version: 1,
  action: 'invite.issue',
  issuerId: 'issuer-james',
  challengeId: 'challenge-123',
  nonce: 'nonce-123',
  request: { customerNote: 'pilot customer' },
});

const ordinaryStore = new FakeStore({ token: null, includeIssuer: false });
const ordinaryApi = new LicensingDashboardApi({
  store: ordinaryStore,
  client: remote,
  publicKey: authority.publicKey,
  product: 'AIPRO',
  enforced: true,
  now: () => now,
});
const ordinaryStatus = await ordinaryApi.status();
assert.equal(ordinaryStatus.activated, false);
assert.equal(ordinaryStatus.reason, 'activation_required');
assert.deepEqual(ordinaryStatus.issuer, { authorized: false });

const activated = await ordinaryApi.activate({ code: ' 123 456 7890 ' });
assert.equal(activated.activated, true);
assert.equal(activated.edition, 'Business');
assert.equal(ordinaryStore.token.includes('.'), true);
assert.equal('entitlement' in activated, false);

await assert.rejects(
  () => ordinaryApi.activate({ code: '123' }),
  error => error.code === 'invalid_invitation_format',
);
await assert.rejects(
  () => ordinaryApi.generate({}),
  error => error.code === 'issuer_not_authorized',
);

console.log('LICENSING_DASHBOARD_API_TEST_OK');
