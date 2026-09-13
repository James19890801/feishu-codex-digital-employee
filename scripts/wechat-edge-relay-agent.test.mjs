import assert from 'node:assert/strict';
import test from 'node:test';

import {
  backoffDelayMs,
  deliverLeaseBatch,
  pollRelayOnce,
} from './wechat-edge-relay-agent.mjs';

test('delivers leased webhook locally and acknowledges only accepted events', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith('/relay/status')) return Response.json({ leadership: { state: 'LOCAL_PRIMARY', owner: 'mac', generation: 1 } });
    if (String(url).endsWith('/relay/lease')) {
      return Response.json({ events: [
        { id: 'a'.repeat(64), body: '{"ok":1}' },
        { id: 'b'.repeat(64), body: '{"ok":2}' },
      ] });
    }
    if (String(url).startsWith('http://127.0.0.1:17656/')) {
      return new Response('', { status: requests.filter(item => item.url.startsWith('http://')).length === 1 ? 202 : 500 });
    }
    if (String(url).endsWith('/relay/ack')) return Response.json({ acked: 1 });
    throw new Error('unexpected request');
  };
  const result = await pollRelayOnce({
    relayOrigin: 'https://relay.example',
    relayToken: 'r'.repeat(32),
    localWebhookUrl: 'http://127.0.0.1:17656/webhooks/gewe/local-secret-abcdefghijkl',
    fetchImpl,
  });
  assert.deepEqual(result, { leased: 2, delivered: 1, failed: 1, acked: 1 });
  const ack = requests.find(item => item.url.endsWith('/relay/ack'));
  assert.deepEqual(JSON.parse(ack.options.body), { ids: ['a'.repeat(64)] });
});

test('does not lease events while a cloud generation owns the relay', async () => {
  const requests = [];
  const result = await pollRelayOnce({
    relayOrigin: 'https://relay.example', relayToken: 'r'.repeat(32),
    localWebhookUrl: 'http://127.0.0.1:17656/webhooks/gewe/local-secret-abcdefghijkl',
    fetchImpl: async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (String(url).endsWith('/relay/status')) {
        return Response.json({ leadership: { state: 'CLOUD_ACTIVE', owner: 'cloud', generation: 2 } });
      }
      throw new Error('the Mac must not lease while cloud is active');
    },
  });
  assert.deepEqual(result, { leased: 0, delivered: 0, failed: 0, acked: 0, skipped: 'not_local_leader' });
  assert.equal(requests.some(request => request.url.endsWith('/relay/lease')), false);
});

test('does not acknowledge when local webhook is unavailable', async () => {
  let acknowledged = false;
  const result = await deliverLeaseBatch({
    events: [{ id: 'c'.repeat(64), body: '{}' }],
    localWebhookUrl: 'http://127.0.0.1:17656/webhooks/gewe/local-secret-abcdefghijkl',
    deliver: async () => { throw new Error('offline'); },
    acknowledge: async () => { acknowledged = true; },
  });
  assert.deepEqual(result, { leased: 1, delivered: 0, failed: 1, acked: 0 });
  assert.equal(acknowledged, false);
});

test('uses bounded exponential backoff with deterministic jitter injection', () => {
  assert.equal(backoffDelayMs(0, () => 0), 1_000);
  assert.equal(backoffDelayMs(3, () => 0), 8_000);
  assert.equal(backoffDelayMs(20, () => 0), 60_000);
  assert.equal(backoffDelayMs(0, () => 1), 1_250);
});
