import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildParityManifest } from '../../src/cloud-parity-manifest.mjs';
import { SqliteRelayStore } from './store.mjs';

function fixture(key = randomBytes(32)) {
  const directory = mkdtempSync(join(tmpdir(), 'aipro-parity-store-'));
  const options = {
    databasePath: join(directory, 'relay.sqlite'),
    artifactDirectory: join(directory, 'artifacts'),
    parityEncryptionKey: key,
  };
  return { directory, options, store: new SqliteRelayStore(options) };
}

test('stores an encrypted version and restores it after database reopen', () => {
  const { directory, options, store } = fixture();
  try {
    const manifest = buildParityManifest({ persona: 'PRIVATE PERSONA', config: { allowAllChats: false } });
    assert.deepEqual(store.savePolicySnapshot({ workerId: 'mac', sequence: 1, manifest, now: 100 }),
      { revision: 1, duplicate: false, digest: manifest.digest });
    store.close();
    assert.equal(readFileSync(options.databasePath).includes(Buffer.from('PRIVATE PERSONA')), false);
    const reopened = new SqliteRelayStore(options);
    assert.deepEqual(reopened.getCurrentPolicy().manifest, manifest);
    reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('rejects stale sequence and tampered section hash without replacing current policy', () => {
  const { directory, store } = fixture();
  try {
    const first = buildParityManifest({ persona: 'first' });
    store.savePolicySnapshot({ workerId: 'mac', sequence: 10, manifest: first });
    const second = buildParityManifest({ persona: 'second' });
    assert.throws(() => store.savePolicySnapshot({ workerId: 'mac', sequence: 9, manifest: second }), /stale/i);
    assert.throws(() => store.savePolicySnapshot({ workerId: 'mac', sequence: 11,
      manifest: { ...second, sections: { ...second.sections,
        persona: { ...second.sections.persona, data: 'tampered' } } } }), /digest/i);
    assert.equal(store.getCurrentPolicy().manifest.digest, first.digest);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('identical resend is idempotent and a newer policy remains in version history', () => {
  const { directory, store } = fixture();
  try {
    const first = buildParityManifest({ persona: 'first' });
    const second = buildParityManifest({ persona: 'second' });
    store.savePolicySnapshot({ workerId: 'mac', sequence: 1, manifest: first });
    assert.equal(store.savePolicySnapshot({ workerId: 'mac', sequence: 1, manifest: first }).duplicate, true);
    assert.equal(store.savePolicySnapshot({ workerId: 'mac', sequence: 2, manifest: second }).revision, 2);
    assert.equal(store.getCurrentPolicy().manifest.digest, second.digest);
    assert.equal(store.getPolicyRevision(1).manifest.digest, first.digest);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('policy methods fail closed without a dedicated encryption key', () => {
  const { directory, options, store } = fixture();
  try {
    store.close();
    const unconfigured = new SqliteRelayStore({ ...options, parityEncryptionKey: undefined });
    assert.throws(() => unconfigured.savePolicySnapshot({ workerId: 'mac', sequence: 1,
      manifest: buildParityManifest({ persona: 'x' }) }), { message: 'parity_unconfigured' });
    unconfigured.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
