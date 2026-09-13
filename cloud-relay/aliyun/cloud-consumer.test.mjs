import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeShadowOnce } from './cloud-consumer.mjs';

test('shadow consumer leases only when cloud owns the generation and never acknowledges', async () => {
  const calls = [];
  const store = { leadershipStatus: () => ({ state: 'CLOUD_ACTIVE', owner: 'cloud', generation: 3 }),
    async lease(value) { calls.push(value); return { events: [{ digest: 'a'.repeat(64), body: '{"ok":true}' }] }; },
    async ack() { throw new Error('shadow mode must never ack'); } };
  assert.deepEqual(await consumeShadowOnce({ store, enabled: true, now: 1_000 }),
    { leased: 1, parsed: 1, malformed: 0, acknowledged: 0, generation: 3 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].leaseMs, 30_000);
});

test('shadow consumer does not lease while Mac remains primary', async () => {
  const store = { leadershipStatus: () => ({ state: 'LOCAL_PRIMARY', owner: 'mac', generation: 1 }),
    async lease() { throw new Error('must not lease'); } };
  assert.deepEqual(await consumeShadowOnce({ store, enabled: true }),
    { leased: 0, parsed: 0, malformed: 0, acknowledged: 0, skipped: 'not_cloud_leader' });
});
