import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { createFailoverWorker } from './routes.mjs';
import { describeCloudImage } from './vision.mjs';

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
  async executeVision(value) { calls.push(['vision', value.generation]); return { text: '测试截图' }; },
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
const consoleHtml = await consoleResponse.text();
assert.match(consoleHtml, /LOCAL_PRIMARY/);
assert.match(consoleHtml, /云端运行时/);
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
const visionResponse = await worker.fetch(new Request('https://failover.test/internal/runtime/vision', {
  method: 'POST', body: JSON.stringify({ generation: 1 }), headers: runtimeHeaders,
}), env);
assert.equal(visionResponse.status, 200);
assert.equal((await visionResponse.json()).text, '测试截图');
assert.deepEqual(calls[3], ['vision', 1]);

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const pngDigest = createHash('sha256').update(png).digest('hex');
const aiCalls = [];
const vision = await describeCloudImage({
  ai: { async run(model, input) { aiCalls.push([model, input]); return { answer: '图片里是一个测试界面' }; } },
  input: {
    image: `data:image/png;base64,${Buffer.from(png).toString('base64')}`,
    digest: pngDigest, bytes: png.byteLength,
  },
});
assert.equal(vision.text, '图片里是一个测试界面');
assert.equal(aiCalls[0][0], '@cf/moondream/moondream3.1-9B-A2B');
assert.equal(aiCalls[0][1].stream, false);
await assert.rejects(() => describeCloudImage({
  ai: { async run() { return { answer: '不应调用' }; } },
  input: { image: 'data:image/png;base64,AAAA', digest: pngDigest, bytes: 3 },
}), /digest/i);
assert.equal((await worker.fetch(new Request('https://failover.test/nope'), env)).status, 404);
const large = request('/v1/heartbeat', 'x'.repeat(70_000));
assert.equal((await worker.fetch(large, env)).status, 413);
console.log('FAILOVER_WORKER_ROUTE_TEST_OK');
