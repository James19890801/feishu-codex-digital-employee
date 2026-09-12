import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayWorker, RelayCoordinator } from './index.mjs';

const callbackSecret = 'callback-secret-abcdefghijkl';
const relayToken = 'relay-token-abcdefghijklmnop';
const artifactToken = 'artifact-token-abcdefghijklm';

function fixture() {
  const calls = [];
  const objects = new Map();
  const stub = {
    async enqueue(value) { calls.push(['enqueue', value]); return { accepted: true, duplicate: false }; },
    async lease(value) { calls.push(['lease', value]); return { events: [] }; },
    async ack(value) { calls.push(['ack', value]); return { acked: value.ids.length }; },
    async status() { return { pending: 0, leased: 0 }; },
  };
  const env = {
    CALLBACK_SECRET: callbackSecret,
    RELAY_TOKEN: relayToken,
    ARTIFACT_TOKEN: artifactToken,
    CANARY_SECRET: 'c'.repeat(48),
    RELAY_COORDINATOR: { getByName: () => stub },
    ARTIFACTS_KV: {
      async put(key, body, options) { objects.set(key, { body: new Uint8Array(await new Response(body).arrayBuffer()), ...options }); },
      async getWithMetadata(key) {
        const object = objects.get(key);
        if (!object) return null;
        return { value: object.body, metadata: object.metadata };
      },
      async delete(key) { objects.delete(key); },
    },
  };
  return { worker: createRelayWorker(), env, calls, objects };
}

test('durably enqueues an exact callback and acknowledges only after storage accepts it', async () => {
  const { worker, env, calls } = fixture();
  const response = await worker.fetch(new Request(
    `https://relay.example/webhooks/gewe/${callbackSecret}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"type":"test"}' },
  ), env);
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true, accepted: true, duplicate: false });
  assert.equal(calls[0][0], 'enqueue');
  assert.equal(calls[0][1].body, '{"type":"test"}');
  assert.match(calls[0][1].digest, /^[a-f0-9]{64}$/);
});

test('rejects callback bodies that are not JSON without enqueueing', async () => {
  const { worker, env, calls } = fixture();
  const response = await worker.fetch(new Request(
    `https://relay.example/webhooks/gewe/${callbackSecret}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not-json' },
  ), env);
  assert.equal(response.status, 400);
  assert.equal(calls.length, 0);
});

test('requires relay bearer token for leasing and acking', async () => {
  const { worker, env, calls } = fixture();
  const denied = await worker.fetch(new Request('https://relay.example/relay/lease', { method: 'POST' }), env);
  assert.equal(denied.status, 401);
  const allowed = await worker.fetch(new Request('https://relay.example/relay/lease', {
    method: 'POST', headers: { authorization: `Bearer ${relayToken}` }, body: '{}',
  }), env);
  assert.equal(allowed.status, 200);
  assert.equal(calls.at(-1)[0], 'lease');
});

test('uploads and serves a short-lived artifact at the callback-compatible URL', async () => {
  const { worker, env } = fixture();
  const key = 'abcdefghijklmnopqrstuvwx';
  const upload = await worker.fetch(new Request(
    `https://relay.example/relay/artifacts/${key}/report.pdf?ttl=300`,
    { method: 'PUT', headers: { authorization: `Bearer ${artifactToken}`, 'content-type': 'application/pdf' }, body: 'pdf-body' },
  ), env);
  assert.equal(upload.status, 201);
  assert.equal((await upload.json()).publicPath, `/webhooks/gewe/${callbackSecret}/artifacts/${key}/report.pdf`);

  const download = await worker.fetch(new Request(
    `https://relay.example/webhooks/gewe/${callbackSecret}/artifacts/${key}/report.pdf`,
  ), env);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), 'pdf-body');
  assert.equal(download.headers.get('cache-control'), 'no-store');
});

test('returns a public health endpoint without revealing queue data', async () => {
  const { worker, env } = fixture();
  const response = await worker.fetch(new Request('https://relay.example/healthz'), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: 'aipro-wechat-relay' });
});

test('coordinator deduplicates, leases, redelivers after expiry and acknowledges', async () => {
  const records = new Map();
  const storage = {
    async get(key) { return records.get(key); },
    async put(key, value) { records.set(key, structuredClone(value)); },
    async delete(key) { return records.delete(key); },
    async list({ prefix } = {}) { return new Map([...records].filter(([key]) => !prefix || key.startsWith(prefix))); },
    async transaction(operation) { return operation(this); },
  };
  const coordinator = new RelayCoordinator({ storage }, {});
  const event = { digest: 'a'.repeat(64), body: '{"x":1}', createdAt: 1_000 };
  assert.deepEqual(await coordinator.enqueue(event), { accepted: true, duplicate: false });
  assert.deepEqual(await coordinator.enqueue(event), { accepted: true, duplicate: true });
  const first = await coordinator.lease({ now: 2_000, leaseMs: 5_000, limit: 1 });
  assert.equal(first.events.length, 1);
  assert.equal((await coordinator.lease({ now: 3_000, leaseMs: 5_000, limit: 1 })).events.length, 0);
  assert.equal((await coordinator.lease({ now: 7_001, leaseMs: 5_000, limit: 1 })).events.length, 1);
  assert.deepEqual(await coordinator.ack({ ids: [event.digest] }), { acked: 1 });
  assert.deepEqual(await coordinator.status({ now: 8_000 }), { pending: 0, leased: 0, total: 0 });
});
