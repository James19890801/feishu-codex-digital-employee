import assert from 'node:assert/strict';
import {
  DomainError,
  InMemoryInvitationRepository,
  InvitationService,
} from './domain.mjs';

let currentTime = Date.parse('2026-08-02T00:00:00.000Z');
let idCounter = 0;
const repository = new InMemoryInvitationRepository();
const service = new InvitationService({
  repository,
  pepper: 'test-only-pepper-with-enough-entropy',
  now: () => currentTime,
  randomId: prefix => `${prefix}_${++idCounter}`,
  issueEntitlement: async payload => ({
    token: `signed:${payload.licenseId}`,
    payload,
  }),
});

const batch = await service.generateBatch({
  issuerId: 'issuer-james',
  count: 10,
  invitationDays: 30,
  licenseDays: 365,
  customerNote: 'Synthetic test customer',
});

assert.equal(batch.codes.length, 10);
assert.equal(new Set(batch.codes).size, 10);
assert.equal(batch.codes.every(code => /^\d{10}$/.test(code)), true);
assert.equal(batch.invitationCount, 10);
assert.equal(repository.invites.size, 10);
for (const record of repository.invites.values()) {
  assert.equal('code' in record, false);
  assert.match(record.codeHash, /^[a-f0-9]{64}$/);
  assert.match(record.lastFour, /^\d{4}$/);
  assert.equal(record.status, 'unused');
}

const firstCode = batch.codes[0];
const activated = await service.activate({
  code: firstCode,
  deviceKeyHash: `sha256:${'a'.repeat(64)}`,
  activationKey: 'install-a',
});
assert.match(activated.entitlement, /^signed:license_/);
assert.equal(activated.license.deviceKeyHash, `sha256:${'a'.repeat(64)}`);
assert.equal(activated.license.edition, 'Business');
assert.equal(activated.license.issuerId, 'issuer-james');

await assert.rejects(
  () => service.activate({
    code: firstCode,
    deviceKeyHash: `sha256:${'b'.repeat(64)}`,
    activationKey: 'install-b',
  }),
  error => error instanceof DomainError
    && error.code === 'invalid_invitation'
    && error.message === 'Invitation code cannot be used.',
);

const concurrentCode = batch.codes[1];
const concurrentResults = await Promise.allSettled([
  service.activate({
    code: concurrentCode,
    deviceKeyHash: `sha256:${'c'.repeat(64)}`,
    activationKey: 'install-c',
  }),
  service.activate({
    code: concurrentCode,
    deviceKeyHash: `sha256:${'d'.repeat(64)}`,
    activationKey: 'install-d',
  }),
]);
assert.equal(concurrentResults.filter(result => result.status === 'fulfilled').length, 1);
assert.equal(concurrentResults.filter(result => result.status === 'rejected').length, 1);
assert.equal(concurrentResults.find(result => result.status === 'rejected').reason.code, 'invalid_invitation');

await service.revokeInvitation({
  issuerId: 'issuer-james',
  invitationId: repository.findByLastFour(batch.codes[2].slice(-4)).id,
});
await assert.rejects(
  () => service.activate({
    code: batch.codes[2],
    deviceKeyHash: `sha256:${'e'.repeat(64)}`,
    activationKey: 'install-e',
  }),
  error => error.code === 'invalid_invitation',
);

const expiringBatch = await service.generateBatch({
  issuerId: 'issuer-james',
  count: 10,
  invitationDays: 1,
  licenseDays: 365,
});
currentTime += 2 * 24 * 60 * 60 * 1000;
await assert.rejects(
  () => service.activate({
    code: expiringBatch.codes[0],
    deviceKeyHash: `sha256:${'f'.repeat(64)}`,
    activationKey: 'install-f',
  }),
  error => error.code === 'invalid_invitation',
);

for (let attempt = 0; attempt < 5; attempt += 1) {
  await assert.rejects(
    () => service.activate({
      code: `${attempt}`.padStart(10, '9'),
      deviceKeyHash: `sha256:${'1'.repeat(64)}`,
      activationKey: 'brute-force-install',
    }),
    error => error.code === 'invalid_invitation',
  );
}
await assert.rejects(
  () => service.activate({
    code: expiringBatch.codes[1],
    deviceKeyHash: `sha256:${'1'.repeat(64)}`,
    activationKey: 'brute-force-install',
  }),
  error => error.code === 'rate_limited' && error.retryAfterSeconds > 0,
);

await assert.rejects(
  () => service.generateBatch({ issuerId: 'issuer-james', count: 9 }),
  /exactly 10/,
);
await assert.rejects(
  () => service.activate({
    code: '1234',
    deviceKeyHash: `sha256:${'2'.repeat(64)}`,
    activationKey: 'invalid-shape',
  }),
  error => error.code === 'invalid_invitation',
);

console.log('LICENSING_DOMAIN_TEST_OK');
