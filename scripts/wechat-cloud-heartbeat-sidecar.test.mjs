import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMainWechatReadiness, runWechatHeartbeatOnce } from './wechat-cloud-heartbeat-sidecar.mjs';

test('only reports WeChat ready when the live main status satisfies every takeover precondition', () => {
  const ready = { healthy: true, process: { alive: true }, aiRuntime: { healthy: true },
    channels: { wechat: { enabled: true, authenticated: true, connected: true,
      callbackListening: true, callbackRegistered: true } } };
  assert.equal(evaluateMainWechatReadiness(ready), true);
  assert.equal(evaluateMainWechatReadiness({ ...ready, aiRuntime: { healthy: false } }), false);
  assert.equal(evaluateMainWechatReadiness({ ...ready, channels: { wechat: {
    ...ready.channels.wechat, callbackRegistered: false } } }), false);
});

test('reconciles policy before emitting a fenced local heartbeat', async () => {
  const calls = [];
  const outcome = await runWechatHeartbeatOnce({
    paritySync: { async reconcile() { calls.push('sync'); return { digest: 'a'.repeat(64), workerSequence: 4 }; } },
    controlClient: { async localGeneration() { calls.push('generation'); return 7; },
      async heartbeat(value) { calls.push(value); return { accepted: true, generation: 7 }; } },
    fetchImpl: async () => ({ ok: true, async json() { return { healthy: true,
      process: { alive: true }, aiRuntime: { healthy: true }, channels: { wechat: {
        enabled: true, authenticated: true, connected: true, callbackListening: true,
        callbackRegistered: true } } }; } }),
    bootId: 'sidecar_test', statusUrl: 'http://127.0.0.1/status',
  });
  assert.deepEqual(outcome, { accepted: true, generation: 7 });
  assert.deepEqual(calls, ['sync', 'generation', { generation: 7, bootId: 'sidecar_test',
    policyDigest: 'a'.repeat(64), criticalStateSequence: 4,
    channels: { wechat: true, dingtalk: false } }]);
});

test('prioritizes healthy recovery over parity sync while cloud owns the channel', async () => {
  const calls = [];
  const outcome = await runWechatHeartbeatOnce({
    paritySync: { async reconcile() { throw new Error('must_not_sync_during_recovery'); } },
    controlClient: {
      async status() { return { state: 'CLOUD_ACTIVE', owner: 'cloud', generation: 2 }; },
      async recoveryHeartbeat(value) { calls.push(value); return { generation: 2, state: 'CLOUD_ACTIVE' }; },
    },
    fetchImpl: async () => ({ ok: true, async json() { return { healthy: true,
      process: { alive: true }, aiRuntime: { healthy: true }, channels: { wechat: {
        enabled: true, authenticated: true, connected: true, callbackListening: true,
        callbackRegistered: true } } }; } }),
    bootId: 'sidecar_test', statusUrl: 'http://127.0.0.1/status',
  });
  assert.deepEqual(outcome, { accepted: true, generation: 2, state: 'CLOUD_ACTIVE' });
  assert.deepEqual(calls, [{ healthy: true }]);
});
