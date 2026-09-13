import assert from 'node:assert/strict';
import test from 'node:test';
import { WeChatCloudMainHeartbeat } from './wechat-cloud-main-heartbeat.mjs';

test('main heartbeat follows acknowledged policy and carries only WeChat readiness', async () => {
  const calls = [];
  const heartbeat = new WeChatCloudMainHeartbeat({
    paritySync: { reconcile: async () => { calls.push('sync'); return {
      digest: 'a'.repeat(64), workerSequence: 9,
    }; } },
    controlClient: {
      localGeneration: async () => { calls.push('generation'); return 3; },
      heartbeat: async snapshot => { calls.push(snapshot); return { accepted: true, generation: 3 }; },
    },
    channelReady: () => true, bootId: 'boot-1',
  });
  assert.deepEqual(await heartbeat.tick(), { accepted: true, generation: 3 });
  assert.equal(calls[0], 'sync');
  assert.equal(calls[1], 'generation');
  assert.deepEqual(calls[2], { generation: 3, bootId: 'boot-1',
    policyDigest: 'a'.repeat(64), criticalStateSequence: 9,
    channels: { wechat: true, dingtalk: false } });
});

test('does not heartbeat after parity failure or loss of local leadership', async () => {
  let sent = 0;
  const make = (reconcile, localGeneration) => new WeChatCloudMainHeartbeat({
    paritySync: { reconcile }, controlClient: {
      localGeneration, heartbeat: async () => { sent += 1; },
    }, channelReady: () => true, bootId: 'boot-1',
  });
  await assert.rejects(make(async () => { throw Error('parity_failed'); }, async () => 1).tick(),
    /parity_failed/);
  await assert.rejects(make(async () => ({ digest: 'a'.repeat(64), workerSequence: 1 }),
    async () => { throw Error('local_not_leader'); }).tick(), /local_not_leader/);
  assert.equal(sent, 0);
});
