import assert from 'node:assert/strict';
import {
  canonicalJson,
  generateSigningKeyPair,
  publicKeyFingerprint,
  signEnvelope,
  verifyEnvelope,
} from '../../../src/licensing/crypto.mjs';
import { InMemoryInvitationRepository } from './domain.mjs';
import { createWorker, keyedDigest } from './index.mjs';

class MemoryWorkerRepository extends InMemoryInvitationRepository {
  constructor() {
    super();
    this.issuers = new Map();
    this.challenges = new Map();
    this.recoveries = new Map();
  }

  async getIssuer(id) {
    const issuer = this.issuers.get(id);
    return issuer ? structuredClone(issuer) : null;
  }

  async createIssuerChallenge(challenge) {
    this.challenges.set(challenge.id, structuredClone(challenge));
  }

  async consumeIssuerChallenge({ id, issuerId, nonceHash, now }) {
    const challenge = this.challenges.get(id);
    if (!challenge
      || challenge.issuerId !== issuerId
      || challenge.nonceHash !== nonceHash
      || challenge.usedAt
      || Date.parse(challenge.expiresAt) < now) return false;
    challenge.usedAt = new Date(now).toISOString();
    return true;
  }

  async consumeRecoveryCredential({
    id,
    secretHash,
    holder,
    newIssuer,
    replacementRecovery,
    now,
  }) {
    const credential = this.recoveries.get(id);
    if (!credential
      || credential.status !== 'active'
      || credential.secretHash !== secretHash
      || credential.holder !== holder) return false;
    credential.status = 'consumed';
    credential.consumedAt = new Date(now).toISOString();
    credential.replacedBy = replacementRecovery.id;
    for (const issuer of this.issuers.values()) {
      if (issuer.holder === holder && issuer.status === 'active') {
        issuer.status = 'revoked';
        issuer.revokedAt = new Date(now).toISOString();
      }
    }
    this.issuers.set(newIssuer.id, structuredClone(newIssuer));
    this.recoveries.set(replacementRecovery.id, structuredClone(replacementRecovery));
    return true;
  }
}

const licenseKeys = generateSigningKeyPair();
const jamesKeys = generateSigningKeyPair();
const attackerKeys = generateSigningKeyPair();
const repository = new MemoryWorkerRepository();
repository.issuers.set('issuer-james-001', {
  id: 'issuer-james-001',
  holder: 'james-feng',
  displayName: 'James Feng',
  publicKey: jamesKeys.publicKey,
  roles: ['invite.issue', 'invite.revoke'],
  status: 'active',
});

const env = {
  INVITATION_HASH_PEPPER: 'invite-test-pepper-at-least-32-bytes',
  RECOVERY_HASH_PEPPER: 'recovery-test-pepper-at-least-32-bytes',
  LICENSE_SIGNING_PRIVATE_KEY: licenseKeys.privateKey,
  CONTACT_CARD_KEY: 'james-wechat.jpg',
  CONTACT_CARD_CONTENT_TYPE: 'image/jpeg',
  CONTACT_CARD_KV: {
    async get(key, options) {
      if (key !== 'james-wechat.jpg') return null;
      assert.equal(options.type, 'arrayBuffer');
      return new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;
    },
  },
};
const worker = createWorker({ repository });

const contactResponse = await worker.fetch(
  new Request('https://license.james.test/v1/contact-card'),
  env,
  {},
);
assert.equal(contactResponse.status, 200);
assert.equal(contactResponse.headers.get('content-type'), 'image/jpeg');
assert.equal(contactResponse.headers.get('x-content-type-options'), 'nosniff');
assert.equal(contactResponse.headers.has('access-control-allow-origin'), false);
assert.deepEqual([...new Uint8Array(await contactResponse.arrayBuffer())], [0xff, 0xd8, 0xff, 0xd9]);

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const request = new Request(`https://license.james.test${path}`, {
    method,
    headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const response = await worker.fetch(request, env, {});
  return { response, json: await response.json() };
}

const health = await call('/v1/health');
assert.equal(health.response.status, 200);
assert.equal(health.json.ok, true);
assert.equal(health.response.headers.get('cache-control'), 'no-store');
assert.match(health.response.headers.get('x-request-id'), /^req_/);
assert.equal(health.response.headers.has('access-control-allow-origin'), false);

const wrongMethod = await call('/v1/health', { method: 'POST', body: {} });
assert.equal(wrongMethod.response.status, 405);
assert.equal(wrongMethod.response.headers.get('allow'), 'GET');

const wrongContentType = await call('/v1/activate', {
  method: 'POST',
  headers: { 'content-type': 'text/plain' },
  body: undefined,
});
assert.equal(wrongContentType.response.status, 415);

const invalidActivation = await call('/v1/activate', {
  method: 'POST',
  body: { code: '0000000000', deviceKeyHash: `sha256:${'a'.repeat(64)}`, installId: 'install-a' },
});
assert.equal(invalidActivation.response.status, 400);
assert.deepEqual(
  { ok: invalidActivation.json.ok, code: invalidActivation.json.error.code },
  { ok: false, code: 'invalid_invitation' },
);
assert.equal(JSON.stringify(invalidActivation.json).includes('0000000000'), false);

const challenge = await call('/v1/issuer/challenge', {
  method: 'POST',
  body: { issuerId: 'issuer-james-001' },
});
assert.equal(challenge.response.status, 200);
assert.match(challenge.json.challenge.id, /^challenge_/);
assert.match(challenge.json.challenge.nonce, /^[A-Za-z0-9_-]{32,}$/);

const inviteRequest = {
  invitationDays: 30,
  licenseDays: 365,
  customerNote: 'Acme synthetic test',
};
const proofPayload = {
  version: 1,
  action: 'invite.issue',
  issuerId: 'issuer-james-001',
  challengeId: challenge.json.challenge.id,
  nonce: challenge.json.challenge.nonce,
  request: inviteRequest,
};
const proof = signEnvelope(proofPayload, jamesKeys.privateKey);
const generated = await call('/v1/issuer/invites', {
  method: 'POST',
  body: { issuerId: 'issuer-james-001', proof, request: inviteRequest },
});
assert.equal(generated.response.status, 201);
assert.equal(generated.json.batch.codes.length, 10);
assert.equal(generated.json.batch.codes.every(code => /^\d{10}$/.test(code)), true);

const replay = await call('/v1/issuer/invites', {
  method: 'POST',
  body: { issuerId: 'issuer-james-001', proof, request: inviteRequest },
});
assert.equal(replay.response.status, 403);
assert.equal(replay.json.error.code, 'issuer_authorization_failed');

const attackChallenge = await call('/v1/issuer/challenge', {
  method: 'POST',
  body: { issuerId: 'issuer-james-001' },
});
const attackerProof = signEnvelope({
  ...proofPayload,
  challengeId: attackChallenge.json.challenge.id,
  nonce: attackChallenge.json.challenge.nonce,
}, attackerKeys.privateKey);
const attacked = await call('/v1/issuer/invites', {
  method: 'POST',
  body: { issuerId: 'issuer-james-001', proof: attackerProof, request: inviteRequest },
});
assert.equal(attacked.response.status, 403);

const recoverySecret = 'recovery-secret-synthetic-value-0001';
repository.recoveries.set('recovery-james-001', {
  id: 'recovery-james-001',
  holder: 'james-feng',
  secretHash: await keyedDigest(recoverySecret, env.RECOVERY_HASH_PEPPER),
  generation: 1,
  status: 'active',
});
const replacementKeys = generateSigningKeyPair();
const recovered = await call('/v1/founder/recover', {
  method: 'POST',
  body: {
    recoveryId: 'recovery-james-001',
    recoverySecret,
    holder: 'james-feng',
    newIssuer: {
      id: 'issuer-james-002',
      displayName: 'James Feng',
      publicKey: replacementKeys.publicKey,
    },
    deviceKeyHash: publicKeyFingerprint(generateSigningKeyPair().publicKey),
  },
});
assert.equal(recovered.response.status, 200);
assert.equal(recovered.json.issuer.id, 'issuer-james-002');
assert.equal(recovered.json.recoveryKit.id.startsWith('recovery_'), true);
assert.match(recovered.json.recoveryKit.secret, /^[A-Za-z0-9_-]{40,}$/);
assert.equal(repository.issuers.get('issuer-james-001').status, 'revoked');
assert.equal(repository.issuers.get('issuer-james-002').status, 'active');
const founderPayload = verifyEnvelope(recovered.json.entitlement, licenseKeys.publicKey);
assert.equal(founderPayload.edition, 'Founder');

const recoveryReplay = await call('/v1/founder/recover', {
  method: 'POST',
  body: {
    recoveryId: 'recovery-james-001',
    recoverySecret,
    holder: 'james-feng',
    newIssuer: {
      id: 'issuer-james-003', displayName: 'James Feng', publicKey: replacementKeys.publicKey,
    },
    deviceKeyHash: publicKeyFingerprint(generateSigningKeyPair().publicKey),
  },
});
assert.equal(recoveryReplay.response.status, 403);
assert.equal(repository.recoveries.get('recovery-james-001').status, 'consumed');

assert.equal(
  canonicalJson(proofPayload).includes('Acme synthetic test'),
  true,
  'issuer proof must bind the complete invite request',
);

console.log('LICENSING_WORKER_TEST_OK');
