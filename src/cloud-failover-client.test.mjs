import assert from 'node:assert/strict';
import {
  CloudFailoverClient,
  signFailoverRequest,
} from './cloud-failover-client.mjs';

const signature = signFailoverRequest({
  method: 'POST',
  path: '/v1/runtime/execute',
  body: '{"level":"L0","prompt":"hello"}',
  timestamp: 1_786_068_000_000,
  nonce: 'nonce-fixed',
  secret: '0123456789abcdef0123456789abcdef',
});
assert.deepEqual(signature, {
  contentSha256: 'a9145914f0fae4de156074df78358f777e7def2c86f5973d908ea7b5bab391c8',
  signature: 'ff17dadc1827b64e6f66e8302d46508f0b752e4b55077539a245c0baeece4723',
});

const requests = [];
const client = new CloudFailoverClient({
  baseUrl: 'https://failover.example.com',
  nodeId: 'node-123',
  secret: '0123456789abcdef0123456789abcdef',
  now: () => 1_786_068_000_000,
  nonce: () => 'nonce-fixed',
  fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({
      ok: true,
      result: { text: 'cloud answer', sessionId: 'sess_123', latencyMs: 42 },
      handoff: { status: 'completed', replayed: true },
      state: 'LOCAL_PRIMARY',
      generation: 0,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  },
});

const executed = await client.execute({ level: 'L0', prompt: 'hello', handoffKey: 'message-123' });
assert.deepEqual(executed, {
  text: 'cloud answer',
  sessionId: 'sess_123',
  latencyMs: 42,
  state: 'LOCAL_PRIMARY',
  generation: 0,
  handoff: { status: 'completed', replayed: true },
});
assert.equal(requests[0].url, 'https://failover.example.com/v1/runtime/execute');
assert.equal(requests[0].options.method, 'POST');
assert.equal(requests[0].options.headers['cache-control'], 'no-store');
assert.equal(requests[0].options.headers['x-aipros-node'], 'node-123');
assert.equal(requests[0].options.headers['x-aipros-timestamp'], '1786068000000');
assert.equal(requests[0].options.headers['x-aipros-nonce'], 'nonce-fixed');
assert.match(requests[0].options.headers['x-aipros-signature'], /^[a-f0-9]{64}$/);
const executePayload = JSON.parse(requests[0].options.body);
assert.match(executePayload.handoffId, /^[a-f0-9]{64}$/);
assert.equal('handoffKey' in executePayload, false);
assert.equal(requests[0].options.body.includes('message-123'), false);

assert.throws(
  () => new CloudFailoverClient({
    baseUrl: 'http://failover.example.com',
    nodeId: 'node-123',
    secret: '0123456789abcdef0123456789abcdef',
  }),
  /https/i,
);

const malformed = new CloudFailoverClient({
  baseUrl: 'https://failover.example.com',
  nodeId: 'node-123',
  secret: '0123456789abcdef0123456789abcdef',
  fetchImpl: async () => new Response('{"ok":true,"result":{}}', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  }),
});
await assert.rejects(() => malformed.execute({ level: 'L0', prompt: 'hello' }), error => (
  error?.code === 'cloud_failover_invalid_response'
));

console.log('CLOUD_FAILOVER_CLIENT_TEST_OK');
