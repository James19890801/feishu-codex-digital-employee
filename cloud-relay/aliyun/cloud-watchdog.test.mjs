import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCloudPromotion, runCloudWatchdogOnce } from './cloud-watchdog.mjs';

const digest = 'a'.repeat(64);
const healthyStore = () => ({
  leadershipStatus: () => ({ state: 'LOCAL_PRIMARY', owner: 'mac', generation: 4, heartbeatAt: 1_000 }),
  lastMainHeartbeat: () => ({ generation: 4, policyDigest: digest, criticalStateSequence: 8,
    channels: { wechat: true, dingtalk: false }, receivedAt: 1_000 }),
  getCurrentPolicy: () => ({ revision: 2, digest }),
  getPolicyCursor: () => ({ sequence: 8, digest }),
  tryCloudTakeover: input => ({ takenOver: input.cloudReady, state: 'CLOUD_ACTIVE', generation: 5 }),
});

test('requires expired, policy-aligned, WeChat-ready main heartbeat and cloud capability', async () => {
  const store = healthyStore();
  assert.deepEqual(await assessCloudPromotion({ store, now: 90_999, cloudReady: true }),
    { ready: false, reasons: ['main_heartbeat_fresh'] });
  assert.deepEqual(await assessCloudPromotion({ store, now: 91_000, cloudReady: false }),
    { ready: false, reasons: ['cloud_capability_unready'] });
  assert.deepEqual(await assessCloudPromotion({ store, now: 91_000, cloudReady: true }),
    { ready: true, reasons: [] });
});

test('watchdog never promotes when disabled and promotes only after its real probe passes', async () => {
  const store = healthyStore();
  let calls = 0;
  assert.deepEqual(await runCloudWatchdogOnce({ store, enabled: false, now: 100_000,
    readinessProbe: async () => { calls += 1; return true; } }), { promoted: false, reason: 'disabled' });
  assert.equal(calls, 0);
  assert.deepEqual(await runCloudWatchdogOnce({ store, enabled: true, now: 100_000,
    readinessProbe: async () => { calls += 1; return true; } }),
  { promoted: true, state: 'CLOUD_ACTIVE', generation: 5 });
  assert.equal(calls, 1);
});
