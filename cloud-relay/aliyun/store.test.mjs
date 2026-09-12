import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { SqliteRelayStore } from './store.mjs';

const directories = [];
const stores = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function create(options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'aipro-relay-'));
  directories.push(directory);
  const config = {
    databasePath: path.join(directory, 'events.sqlite'),
    artifactDirectory: path.join(directory, 'artifacts'),
    ...options,
  };
  const store = new SqliteRelayStore(config);
  stores.push(store);
  return { store, config };
}

const digest = 'a'.repeat(64);

test('enqueue deduplicates and survives restart', async () => {
  const { store, config } = await create();
  assert.deepEqual(await store.enqueue({ digest, body: '{}', createdAt: 100 }), { accepted: true, duplicate: false });
  assert.deepEqual(await store.enqueue({ digest, body: '{}', createdAt: 101 }), { accepted: true, duplicate: true });
  store.close();
  stores.splice(stores.indexOf(store), 1);
  const reopened = new SqliteRelayStore(config);
  stores.push(reopened);
  assert.deepEqual(await reopened.status({ now: 200 }), { pending: 1, leased: 0, total: 1 });
  assert.equal((await reopened.lease({ now: 200 })).events[0].body, '{}');
});

test('lease expires and redelivers oldest event until ACK', async () => {
  const { store } = await create();
  await store.enqueue({ digest, body: '{"n":1}', createdAt: 100 });
  await store.enqueue({ digest: 'b'.repeat(64), body: '{"n":2}', createdAt: 200 });
  const first = await store.lease({ now: 300, leaseMs: 5000, limit: 1 });
  assert.deepEqual(first.events.map(event => event.id), [digest]);
  assert.equal(first.events[0].attempts, 1);
  assert.deepEqual(await store.status({ now: 301 }), { pending: 1, leased: 1, total: 2 });
  const second = await store.lease({ now: 5301, leaseMs: 5000, limit: 1 });
  assert.equal(second.events[0].id, digest);
  assert.equal(second.events[0].attempts, 2);
  assert.deepEqual(await store.ack({ ids: [digest, digest, 'invalid'] }), { acked: 1 });
  assert.deepEqual(await store.status({ now: 5302 }), { pending: 1, leased: 0, total: 1 });
});

test('bounded queue fails closed without losing earlier events', async () => {
  const { store } = await create({ maxQueueCount: 1 });
  await store.enqueue({ digest, body: '{}', createdAt: 100 });
  await assert.rejects(store.enqueue({ digest: 'b'.repeat(64), body: '{}', createdAt: 101 }), /queue_full/);
  assert.deepEqual(await store.status({ now: 200 }), { pending: 1, leased: 0, total: 1 });
});

test('artifact bytes survive restart and expire', async () => {
  const { store, config } = await create();
  const key = 'artifact-key-1234567890123456';
  await store.putArtifact(key, {
    bytes: Buffer.from('hello'), expiresAt: 200, fileName: 'hello.txt', contentType: 'text/plain',
  });
  assert.equal((await store.getArtifact(key)).bytes.toString(), 'hello');
  store.close();
  stores.splice(stores.indexOf(store), 1);
  const reopened = new SqliteRelayStore(config);
  stores.push(reopened);
  assert.equal((await reopened.getArtifact(key)).fileName, 'hello.txt');
  assert.equal((await readFile(path.join(config.artifactDirectory, key))).toString(), 'hello');
  assert.deepEqual(await reopened.cleanupArtifacts(201), { removed: 1 });
  assert.equal(await reopened.getArtifact(key), null);
});
