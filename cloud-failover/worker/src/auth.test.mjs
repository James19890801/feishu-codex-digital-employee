import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { InMemoryReplayStore, verifySignedRequest } from './auth.mjs';

const now = 1_786_060_800_000;
const body = JSON.stringify({ ok: true });
const path = '/v1/heartbeat';
const secret = 'unit-test-secret-with-enough-bytes';
function signedRequest({ requestBody = body, timestamp = now, nonce = 'nonce-12345678', node = 'node-1' } = {}) {
  const digest = createHash('sha256').update(body).digest('hex');
  const signature = createHmac('sha256', secret)
    .update(['POST', path, timestamp, nonce, digest].join('\n')).digest('hex');
  return new Request(`https://failover.test${path}`, {
    method: 'POST', body: requestBody,
    headers: {
      'x-aipros-node': node, 'x-aipros-timestamp': String(timestamp),
      'x-aipros-nonce': nonce, 'x-aipros-content-sha256': digest,
      'x-aipros-signature': signature,
    },
  });
}
const env = { AIPROS_NODE_ID: 'node-1', AIPROS_HMAC_SECRET: secret };
const replay = new InMemoryReplayStore();
assert.equal((await verifySignedRequest(signedRequest(), env, replay, now)).body, body);
await assert.rejects(() => verifySignedRequest(signedRequest(), env, replay, now), error => error.code === 'nonce_replayed');
await assert.rejects(() => verifySignedRequest(signedRequest({ requestBody: '{"ok":false}', nonce: 'nonce-tampered' }), env, new InMemoryReplayStore(), now),
  error => error.code === 'body_tampered');
await assert.rejects(() => verifySignedRequest(signedRequest({ timestamp: now - 90_001, nonce: 'nonce-expired1' }), env, new InMemoryReplayStore(), now),
  error => error.code === 'request_expired');
await assert.rejects(() => verifySignedRequest(signedRequest({ node: 'unknown-node', nonce: 'nonce-unknown1' }), env, new InMemoryReplayStore(), now),
  error => error.code === 'unknown_node');
console.log('FAILOVER_AUTH_TEST_OK');
