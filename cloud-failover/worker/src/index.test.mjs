import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createFailoverWorker } from './routes.mjs';

const secret = 'worker-route-test-secret-123456';
const now = Date.now();
function request(path, body = '', method = 'POST') {
  const nonce = `nonce-${Math.random().toString(36).slice(2)}`;
  const digest = createHash('sha256').update(body).digest('hex');
  const signature = createHmac('sha256', secret).update([method, path, now, nonce, digest].join('\n')).digest('hex');
  return new Request(`https://failover.test${path}`, { method, body: body || undefined, headers: {
    'x-aipros-node': 'node-1', 'x-aipros-timestamp': String(now), 'x-aipros-nonce': nonce,
    'x-aipros-content-sha256': digest, 'x-aipros-signature': signature,
  } });
}
const calls = [];
const stub = {
  async useNonce() { return true; },
  async heartbeat(value) { calls.push(value); return { state: 'LOCAL_PRIMARY', generation: 0 }; },
  async executeQoder() { throw new Error('not used'); },
  async status() { return { state: 'LOCAL_PRIMARY', generation: 0, protocolVersion: '1' }; },
};
const env = {
  AIPROS_NODE_ID: 'node-1', AIPROS_HMAC_SECRET: secret,
  FAILOVER_COORDINATOR: { idFromName: name => name, get: () => stub },
};
const worker = createFailoverWorker();
const response = await worker.fetch(request('/v1/heartbeat', JSON.stringify({ at: '2026-08-07T00:00:00Z' })), env);
assert.equal(response.status, 200);
assert.equal(response.headers.get('cache-control'), 'no-store');
assert.deepEqual(calls[0], { at: '2026-08-07T00:00:00Z' });
assert.equal((await worker.fetch(new Request('https://failover.test/nope'), env)).status, 404);
const large = request('/v1/heartbeat', 'x'.repeat(70_000));
assert.equal((await worker.fetch(large, env)).status, 413);
console.log('FAILOVER_WORKER_ROUTE_TEST_OK');
