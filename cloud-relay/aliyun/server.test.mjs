import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { createRelayServer } from './server.mjs';

const servers = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

async function start(options = {}) {
  const calls = [];
  const store = options.store || {
    async enqueue(event) { calls.push(['enqueue', event]); return { accepted: true, duplicate: false }; },
    async lease(input) { calls.push(['lease', input]); return { events: [] }; },
    async ack(input) { calls.push(['ack', input]); return { acked: input.ids.length }; },
    async status() { return { pending: 0, leased: 0, total: 0 }; },
    async putArtifact() { return undefined; },
    async getArtifact() { return null; },
  };
  const server = createRelayServer({
    store,
    callbackSecret: 'callback-secret-1234567890123456',
    relayToken: 'relay-token-123456789012345678',
    artifactToken: 'artifact-token-1234567890123456',
    canarySecret: 'canary-secret-12345678901234567890',
    now: () => 1_800_000_000_000,
    ...options,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { origin: `http://127.0.0.1:${server.address().port}`, calls };
}

test('health does not expose queue or secrets', async () => {
  const { origin } = await start();
  const response = await fetch(`${origin}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: 'aipro-wechat-relay' });
});

test('valid GeWe callback is accepted after durable enqueue and deduplicated by digest', async () => {
  const { origin, calls } = await start();
  const response = await fetch(`${origin}/webhooks/gewe/callback-secret-1234567890123456`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"hello":"world"}',
  });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'enqueue');
  assert.equal(calls[0][1].body, '{"hello":"world"}');
  assert.match(calls[0][1].digest, /^[a-f0-9]{64}$/);
});

test('failed storage gives GeWe a non-success status', async () => {
  const { origin } = await start({ store: { enqueue() { throw new Error('disk full'); } } });
  const response = await fetch(`${origin}/webhooks/gewe/callback-secret-1234567890123456`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(response.status, 503);
});

test('callback rejects invalid media type and malformed JSON', async () => {
  const { origin, calls } = await start();
  const path = `${origin}/webhooks/gewe/callback-secret-1234567890123456`;
  assert.equal((await fetch(path, { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })).status, 400);
  assert.equal(calls.length, 0);
});

test('lease, ack and status require the relay bearer token', async () => {
  const { origin, calls } = await start();
  assert.equal((await fetch(`${origin}/relay/lease`, { method: 'POST', body: '{}' })).status, 401);
  const headers = { authorization: 'Bearer relay-token-123456789012345678', 'content-type': 'application/json' };
  assert.equal((await fetch(`${origin}/relay/lease`, { method: 'POST', headers, body: '{}' })).status, 200);
  assert.equal((await fetch(`${origin}/relay/ack`, { method: 'POST', headers, body: '{"ids":[]}' })).status, 200);
  assert.equal((await fetch(`${origin}/relay/status`, { headers })).status, 200);
  assert.deepEqual(calls.map(call => call[0]), ['lease', 'ack']);
});

test('artifact upload keeps callback-compatible public path and expires', async () => {
  let clock = 1_800_000_000_000;
  const objects = new Map();
  const store = {
    async putArtifact(key, value) { objects.set(key, value); },
    async getArtifact(key) { return objects.get(key) || null; },
  };
  const { origin } = await start({ store, now: () => clock });
  const key = 'artifact-key-1234567890123456';
  const upload = `${origin}/relay/artifacts/${key}/hello.txt?ttl=30`;
  assert.equal((await fetch(upload, { method: 'PUT', body: 'hello' })).status, 401);
  const response = await fetch(upload, {
    method: 'PUT',
    headers: { authorization: 'Bearer artifact-token-1234567890123456', 'content-type': 'text/plain' },
    body: 'hello',
  });
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.publicPath, `/webhooks/gewe/callback-secret-1234567890123456/artifacts/${key}/hello.txt`);
  const downloaded = await fetch(`${origin}${result.publicPath}`);
  assert.equal(downloaded.status, 200);
  assert.equal(await downloaded.text(), 'hello');
  clock += 30_001;
  assert.equal((await fetch(`${origin}${result.publicPath}`)).status, 404);
});

test('artifact upload rejects empty bodies', async () => {
  const { origin } = await start();
  const response = await fetch(`${origin}/relay/artifacts/artifact-key-1234567890123456/hello.txt`, {
    method: 'PUT', headers: { authorization: 'Bearer artifact-token-1234567890123456' }, body: '',
  });
  assert.equal(response.status, 413);
});

test('signed canary verifies the existing health-check protocol', async () => {
  const { origin } = await start();
  const timestamp = '1800000000000';
  const nonce = 'aliyun-smoke';
  const signature = createHmac('sha256', 'canary-secret-12345678901234567890').update(`${timestamp}.${nonce}`).digest('hex');
  const url = `${origin}/internal/reliability/canary?timestamp=${timestamp}&nonce=${nonce}&signature=${signature}`;
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.equal((await fetch(`${origin}/internal/reliability/canary?timestamp=${timestamp}&nonce=${nonce}&signature=${'0'.repeat(64)}`)).status, 404);
});

test('callback refuses a body exceeding one MiB', async () => {
  const { origin, calls } = await start();
  const response = await fetch(`${origin}/webhooks/gewe/callback-secret-1234567890123456`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(1024 * 1024) }),
  });
  assert.equal(response.status, 413);
  assert.equal(calls.length, 0);
});
