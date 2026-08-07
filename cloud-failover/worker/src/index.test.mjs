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
  async lease() { calls.push('lease'); return { state: 'TAKING_OVER', generation: 1 }; },
  async containerReady(generation) { calls.push(['ready', generation]); return { state: 'CLOUD_ACTIVE', generation }; },
  async claim() { throw new Error('not used'); },
  async complete() { throw new Error('not used'); },
  async executeQoder() { throw new Error('not used'); },
  async status() { return { state: 'LOCAL_PRIMARY', generation: 0, protocolVersion: '1' }; },
};
const env = {
  AIPROS_NODE_ID: 'node-1', AIPROS_HMAC_SECRET: secret,
  AIPROS_CONTAINER_TOKEN: 'runtime-token',
  CLOUDFLARE_CONSOLE_USERNAME: 'owner@example.com',
  CLOUDFLARE_CONSOLE_PASSWORD: 'console-pass',
  FAILOVER_COORDINATOR: { idFromName: name => name, get: () => stub },
};
const worker = createFailoverWorker();
const unauthorizedConsole = await worker.fetch(new Request('https://failover.test/'), env);
assert.equal(unauthorizedConsole.status, 401);
const consoleResponse = await worker.fetch(new Request('https://failover.test/', {
  headers: { authorization: `Basic ${btoa('owner@example.com:console-pass')}` },
}), env);
assert.equal(consoleResponse.status, 200);
assert.match(await consoleResponse.text(), /LOCAL_PRIMARY/);
assert.equal(consoleResponse.headers.get('x-frame-options'), 'DENY');
const oldUsernameResponse = await worker.fetch(new Request('https://failover.test/', {
  headers: { authorization: `Basic ${btoa('aipros:console-pass')}` },
}), env);
assert.equal(oldUsernameResponse.status, 401);
const response = await worker.fetch(request('/v1/heartbeat', JSON.stringify({
  at: '2026-08-07T00:00:00Z', dwsConnected: true, runtimeHealthy: true,
})), env);
assert.equal(response.status, 200);
assert.equal(response.headers.get('cache-control'), 'no-store');
assert.deepEqual(calls[0], {
  at: '2026-08-07T00:00:00Z', dwsConnected: true, runtimeHealthy: true,
});
const unauthorizedLease = await worker.fetch(new Request('https://failover.test/internal/runtime/lease', {
  method: 'POST', body: '{}', headers: { 'content-type': 'application/json' },
}), env);
assert.equal(unauthorizedLease.status, 401);
const runtimeHeaders = { authorization: 'Bearer runtime-token', 'content-type': 'application/json' };
const leaseResponse = await worker.fetch(new Request('https://failover.test/internal/runtime/lease', {
  method: 'POST', body: '{}', headers: runtimeHeaders,
}), env);
assert.equal(leaseResponse.status, 200);
assert.equal((await leaseResponse.json()).state, 'TAKING_OVER');
assert.equal(calls[1], 'lease');
const readyResponse = await worker.fetch(new Request('https://failover.test/internal/runtime/ready', {
  method: 'POST', body: JSON.stringify({ generation: 1 }), headers: runtimeHeaders,
}), env);
assert.equal(readyResponse.status, 200);
assert.deepEqual(calls[2], ['ready', 1]);
assert.equal((await worker.fetch(new Request('https://failover.test/nope'), env)).status, 404);
const large = request('/v1/heartbeat', 'x'.repeat(70_000));
assert.equal((await worker.fetch(large, env)).status, 413);
console.log('FAILOVER_WORKER_ROUTE_TEST_OK');
