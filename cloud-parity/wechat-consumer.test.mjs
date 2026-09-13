import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeWechatOnce } from './wechat-consumer.mjs';

const token = 'r'.repeat(32);
const first = { id: 'a'.repeat(64), body: '{}' };
const second = { id: 'b'.repeat(64), body: '{}' };

test('cloud consumer leases only while cloud owns the active generation', async () => {
  const calls = [];
  const result = await consumeWechatOnce({ relayOrigin: 'https://relay.example', relayToken: token,
    processEvent: async () => ({ outcome: 'replied' }), fetchImpl: async (url, options = {}) => {
      calls.push([String(url), options]);
      return Response.json({ leadership: { state: 'LOCAL_PRIMARY', owner: 'mac', generation: 1 } });
    } });
  assert.deepEqual(result, { leased: 0, acknowledged: 0, skipped: 'not_cloud_leader' });
  assert.equal(calls.length, 1);
});

test('cloud consumer acks terminal outcomes but leaves ambiguous events leased', async () => {
  const calls = [];
  const result = await consumeWechatOnce({ relayOrigin: 'https://relay.example', relayToken: token,
    processEvent: async item => item.id === first.id ? { outcome: 'replied' } : { outcome: 'ambiguous' },
    fetchImpl: async (url, options = {}) => {
      calls.push([String(url), options]);
      if (String(url).endsWith('/relay/status')) return Response.json({ leadership: { state: 'CLOUD_ACTIVE', owner: 'cloud', generation: 2 } });
      if (String(url).endsWith('/relay/lease')) return Response.json({ events: [first, second] });
      if (String(url).endsWith('/relay/ack')) return Response.json({ acked: 1 });
      throw new Error('unexpected');
    } });
  assert.deepEqual(result, { leased: 2, acknowledged: 1, ambiguous: 1 });
  const ack = calls.find(([url]) => url.endsWith('/relay/ack'));
  assert.deepEqual(JSON.parse(ack[1].body), { ids: [first.id] });
});
