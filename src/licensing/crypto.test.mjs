import assert from 'node:assert/strict';
import {
  canonicalJson,
  evaluateEntitlement,
  generateSigningKeyPair,
  publicKeyFingerprint,
  signEnvelope,
  verifyEnvelope,
} from './crypto.mjs';

assert.equal(
  canonicalJson({ z: 1, a: { y: 2, x: [3, { b: true, a: null }] } }),
  '{"a":{"x":[3,{"a":null,"b":true}],"y":2},"z":1}',
);
assert.throws(() => canonicalJson({ unsafe: Number.NaN }), /finite JSON number/);
assert.throws(() => canonicalJson({ missing: undefined }), /unsupported JSON value/);

const issuer = generateSigningKeyPair();
const otherIssuer = generateSigningKeyPair();
assert.match(issuer.privateKey, /^[A-Za-z0-9_-]+$/);
assert.match(issuer.publicKey, /^[A-Za-z0-9_-]+$/);
assert.notEqual(issuer.privateKey, otherIssuer.privateKey);
assert.match(publicKeyFingerprint(issuer.publicKey), /^sha256:[a-f0-9]{64}$/);
assert.equal(publicKeyFingerprint(issuer.publicKey), publicKeyFingerprint(issuer.publicKey));

const payload = {
  version: 1,
  product: 'AIPRO',
  licenseId: 'lic_test',
  edition: 'Founder',
  deviceKeyHash: publicKeyFingerprint(generateSigningKeyPair().publicKey),
  notBefore: '2026-08-01T00:00:00.000Z',
  expiresAt: '2027-08-01T00:00:00.000Z',
};
const token = signEnvelope(payload, issuer.privateKey);
assert.deepEqual(verifyEnvelope(token, issuer.publicKey), payload);
assert.throws(() => verifyEnvelope(token, otherIssuer.publicKey), /signature is invalid/);

const [body, signature] = token.split('.');
const tamperedBody = Buffer.from(
  canonicalJson({ ...payload, edition: 'Business' }),
).toString('base64url');
assert.throws(
  () => verifyEnvelope(`${tamperedBody}.${signature}`, issuer.publicKey),
  /signature is invalid/,
);
assert.throws(() => verifyEnvelope(`${body}.invalid!`, issuer.publicKey), /malformed/);
assert.throws(() => verifyEnvelope('not-a-token', issuer.publicKey), /malformed/);
assert.throws(
  () => verifyEnvelope(`${'a'.repeat(30_000)}.${signature}`, issuer.publicKey),
  /too large/,
);

assert.deepEqual(evaluateEntitlement(payload, {
  product: 'AIPRO',
  deviceKeyHash: payload.deviceKeyHash,
  now: new Date('2026-08-02T00:00:00.000Z'),
}), { valid: true, reason: 'valid' });
assert.deepEqual(evaluateEntitlement(payload, {
  product: 'OTHER',
  deviceKeyHash: payload.deviceKeyHash,
  now: new Date('2026-08-02T00:00:00.000Z'),
}), { valid: false, reason: 'wrong_product' });
assert.deepEqual(evaluateEntitlement(payload, {
  product: 'AIPRO',
  deviceKeyHash: 'sha256:another-device',
  now: new Date('2026-08-02T00:00:00.000Z'),
}), { valid: false, reason: 'wrong_device' });
assert.deepEqual(evaluateEntitlement(payload, {
  product: 'AIPRO',
  deviceKeyHash: payload.deviceKeyHash,
  now: new Date('2026-07-01T00:00:00.000Z'),
}), { valid: false, reason: 'not_yet_valid' });
assert.deepEqual(evaluateEntitlement(payload, {
  product: 'AIPRO',
  deviceKeyHash: payload.deviceKeyHash,
  now: new Date('2027-08-01T00:00:00.001Z'),
}), { valid: false, reason: 'expired' });
assert.deepEqual(evaluateEntitlement({ ...payload, expiresAt: 'bad-date' }, {
  product: 'AIPRO',
  deviceKeyHash: payload.deviceKeyHash,
  now: new Date('2026-08-02T00:00:00.000Z'),
}), { valid: false, reason: 'invalid_time' });

console.log('LICENSING_CRYPTO_TEST_OK');
