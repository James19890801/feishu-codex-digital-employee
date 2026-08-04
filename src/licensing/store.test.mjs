import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  bootstrapFounder,
  LICENSING_ACCOUNTS,
  LicensingStore,
  writeRecoveryKitFile,
} from './store.mjs';

class MemorySecrets {
  values = new Map();
  async get(account) { return this.values.get(account) ?? null; }
  async put(account, value) { this.values.set(account, value); }
  async remove(account) { this.values.delete(account); }
}

const secrets = new MemorySecrets();
const store = new LicensingStore({ secrets });
const deviceA = await store.ensureDeviceIdentity();
const deviceB = await store.ensureDeviceIdentity();
assert.deepEqual(deviceB, deviceA);
assert.match(deviceA.keyHash, /^sha256:[a-f0-9]{64}$/);
assert.equal(secrets.values.has(LICENSING_ACCOUNTS.devicePrivateKey), true);
assert.equal(secrets.values.has(LICENSING_ACCOUNTS.devicePublicKey), true);

const issuerA = await store.ensureIssuerIdentity({
  issuerId: 'issuer-james',
  displayName: 'James Feng',
});
const issuerB = await store.ensureIssuerIdentity({
  issuerId: 'issuer-james',
  displayName: 'James Feng',
});
assert.deepEqual(issuerB, issuerA);
assert.equal(secrets.values.has(LICENSING_ACCOUNTS.issuerPrivateKey), true);
assert.equal(secrets.values.has(LICENSING_ACCOUNTS.issuerMetadata), true);

await store.saveEntitlement('header.signature');
assert.equal(await store.loadEntitlement(), 'header.signature');
await store.saveRecoveryState({ id: 'recovery-next', secret: 'never-print-this' });
assert.deepEqual(await store.loadRecoveryState(), {
  id: 'recovery-next',
  secret: 'never-print-this',
});

const corruptSecrets = new MemorySecrets();
corruptSecrets.values.set(LICENSING_ACCOUNTS.devicePrivateKey, 'corrupt');
corruptSecrets.values.set(LICENSING_ACCOUNTS.devicePublicKey, 'corrupt');
await assert.rejects(
  () => new LicensingStore({ secrets: corruptSecrets }).ensureDeviceIdentity(),
  error => error.code === 'corrupt_device_identity',
);

const events = [];
const founderSecrets = new MemorySecrets();
const founderStore = new LicensingStore({ secrets: founderSecrets });
const result = await bootstrapFounder({
  store: founderStore,
  holder: 'james-feng',
  issuerId: 'issuer-james',
  displayName: 'James Feng',
  recoveryKit: { id: 'recovery-initial', secret: 'x'.repeat(32) },
  recover: async request => {
    events.push(`recover:${request.deviceKeyHash}:${request.newIssuer.id}`);
    return {
      entitlement: 'founder.entitlement',
      recoveryKit: { id: 'recovery-rotated', secret: 'y'.repeat(36) },
      issuer: { id: 'issuer-james', displayName: 'James Feng' },
    };
  },
  verifyEntitlement: async token => {
    events.push(`verify:${token}`);
    return { valid: true, edition: 'Founder' };
  },
});
assert.equal(result.issuer.id, 'issuer-james');
assert.equal(await founderStore.loadEntitlement(), 'founder.entitlement');
assert.deepEqual(await founderStore.loadRecoveryState(), {
  id: 'recovery-rotated',
  secret: 'y'.repeat(36),
});
assert.deepEqual(await founderStore.loadFounderMarker(), {
  edition: 'Founder',
  issuerId: 'issuer-james',
});
assert.equal(events[0].startsWith('recover:'), true);
assert.equal(events[1], 'verify:founder.entitlement');

const failedSecrets = new MemorySecrets();
const failedStore = new LicensingStore({ secrets: failedSecrets });
await assert.rejects(() => bootstrapFounder({
  store: failedStore,
  holder: 'james-feng',
  issuerId: 'issuer-failed',
  displayName: 'James Feng',
  recoveryKit: { id: 'recovery-initial', secret: 'x'.repeat(32) },
  recover: async () => ({
    entitlement: 'bad.entitlement',
    recoveryKit: { id: 'never-store', secret: 'z'.repeat(36) },
    issuer: { id: 'issuer-failed', displayName: 'James Feng' },
  }),
  verifyEntitlement: async () => ({ valid: false, reason: 'invalid_signature' }),
}));
assert.equal(await failedStore.loadFounderMarker(), null);
assert.equal(await failedStore.loadEntitlement(), null);

const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'james-recovery-'));
const recoveryPath = path.join(tempDirectory, 'founder-recovery.json');
await writeRecoveryKitFile(recoveryPath, {
  version: 1,
  holder: 'james-feng',
  recoveryKit: { id: 'recovery-file', secret: 'q'.repeat(36) },
});
const recoveryMode = (await stat(recoveryPath)).mode & 0o777;
assert.equal(recoveryMode, 0o600);
assert.equal(JSON.parse(await readFile(recoveryPath, 'utf8')).holder, 'james-feng');

console.log('LICENSING_STORE_TEST_OK');
