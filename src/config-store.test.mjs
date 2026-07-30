import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const store = await import('./config-store.mjs').catch(() => ({}));

assert.equal(
  typeof store.readConfigurationDocuments,
  'function',
  'readConfigurationDocuments must exist before configuration files can be managed',
);
assert.equal(typeof store.writeConfigurationDocuments, 'function');
assert.equal(typeof store.createConfigurationSnapshot, 'function');
assert.equal(typeof store.listConfigurationSnapshots, 'function');
assert.equal(typeof store.restoreConfigurationSnapshot, 'function');
assert.equal(typeof store.appendConfigurationAudit, 'function');

const root = await mkdtemp(join(tmpdir(), 'aipro-config-store-'));
try {
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'config.local.json'), JSON.stringify({
    feishuAppId: 'cli_aaaaaaaaaaaaaaaa',
    ownerOpenId: 'ou_owner123',
    pollIntervalMs: 5000,
  }, null, 2));
  await writeFile(join(root, 'PERSONA.md'), '# Persona\n\nOriginal.\n');
  await writeFile(join(root, 'BIBLE.md'), '# Bible\n\nOriginal.\n');
  await writeFile(join(root, 'knowledge-catalog.json'), '[]\n');

  const original = await store.readConfigurationDocuments(root);
  assert.equal(original.config.pollIntervalMs, 5000);
  assert.match(original.persona, /Original/);

  const snapshot = await store.createConfigurationSnapshot(root, {
    id: 'snapshot-test001',
    createdAt: '2026-07-30T00:00:00.000Z',
    summary: 'Before polling update',
    planId: 'plan-test001',
  });
  assert.equal(snapshot.id, 'snapshot-test001');

  await store.writeConfigurationDocuments(root, {
    ...original,
    config: { ...original.config, pollIntervalMs: 3000 },
    persona: '# Persona\n\nUpdated.\n',
  });

  const updated = await store.readConfigurationDocuments(root);
  assert.equal(updated.config.pollIntervalMs, 3000);
  assert.match(updated.persona, /Updated/);

  const history = await store.listConfigurationSnapshots(root);
  assert.equal(history.length, 1);
  assert.equal(history[0].summary, 'Before polling update');

  await store.restoreConfigurationSnapshot(root, 'snapshot-test001');
  const restored = await store.readConfigurationDocuments(root);
  assert.equal(restored.config.pollIntervalMs, 5000);
  assert.match(restored.persona, /Original/);

  await assert.rejects(
    store.restoreConfigurationSnapshot(root, '../outside'),
    /invalid snapshot/i,
  );

  await store.appendConfigurationAudit(root, {
    event: 'configuration_applied',
    summary: 'Polling updated',
    at: '2026-07-30T00:01:00.000Z',
  });
  const audit = await readFile(join(root, 'data', 'configuration-audit.jsonl'), 'utf8');
  assert.match(audit, /configuration_applied/);
  assert.match(audit, /Polling updated/);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('CONFIG_STORE_TEST_OK');
