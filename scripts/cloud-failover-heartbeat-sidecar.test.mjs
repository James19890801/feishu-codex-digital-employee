import assert from 'node:assert/strict';
import {
  buildHeartbeatSnapshot,
  hasFreshIntegratedHeartbeat,
  runHeartbeatOnce,
} from './cloud-failover-heartbeat-sidecar.mjs';

const healthyStatus = {
  healthy: true,
  process: { alive: true },
  aiRuntime: { healthy: true },
  channels: { dingtalk: { authenticated: true, connected: true } },
};
assert.deepEqual(buildHeartbeatSnapshot(healthyStatus, {
  sequence: 2,
  at: '2026-08-12T00:00:00.000Z',
  serviceStartId: 'sidecar-1',
}), {
  sequence: 2,
  at: '2026-08-12T00:00:00.000Z',
  serviceStartId: 'sidecar-1',
  dwsConnected: true,
  runtimeHealthy: true,
  lastMessageDigest: '',
  appVersion: '1.0.0-sidecar',
  protocolVersion: '1',
});

const unhealthy = buildHeartbeatSnapshot({
  ...healthyStatus,
  aiRuntime: { healthy: false },
}, { sequence: 3, at: '2026-08-12T00:00:30.000Z', serviceStartId: 'sidecar-1' });
assert.equal(unhealthy.dwsConnected, true);
assert.equal(unhealthy.runtimeHealthy, false);

const historicalDeadLetter = buildHeartbeatSnapshot({
  ...healthyStatus,
  healthy: false,
  issues: ['messages_failed'],
  messageQueue: { overdueFailed: 1 },
}, { sequence: 4, at: '2026-08-12T00:01:00.000Z', serviceStartId: 'sidecar-1' });
assert.equal(historicalDeadLetter.dwsConnected, true);
assert.equal(historicalDeadLetter.runtimeHealthy, true,
  'historical dead letters must not transfer live outbound ownership to cloud');

assert.equal(hasFreshIntegratedHeartbeat({
  cloudFailover: { enabled: true, configured: true, lastHeartbeatAt: '2026-08-12T00:00:00.000Z' },
}, { now: () => new Date('2026-08-12T00:00:59.000Z'), maxAgeMs: 60_000 }), true);
assert.equal(hasFreshIntegratedHeartbeat({
  cloudFailover: { enabled: true, configured: true, lastHeartbeatAt: '2026-08-12T00:00:00.000Z' },
}, { now: () => new Date('2026-08-12T00:01:01.000Z'), maxAgeMs: 60_000 }), false);

const calls = [];
const result = await runHeartbeatOnce({
  client: { async heartbeat(payload) { calls.push(payload); return { state: 'LOCAL_PRIMARY', generation: 4 }; } },
  fetchImpl: async () => new Response(JSON.stringify(healthyStatus), {
    status: 200, headers: { 'content-type': 'application/json' },
  }),
  statusUrl: 'http://127.0.0.1:17655/api/status',
  sequence: 1,
  serviceStartId: 'sidecar-1',
  now: () => new Date('2026-08-12T00:00:00.000Z'),
});
assert.equal(calls.length, 1);
assert.equal(result.state, 'LOCAL_PRIMARY');
let concurrentCalls = 0;
const concurrent = await runHeartbeatOnce({
  client: { async heartbeat() { concurrentCalls += 1; throw new Error('must not send'); } },
  fetchImpl: async () => new Response(JSON.stringify({
    ...healthyStatus,
    cloudFailover: {
      enabled: true, configured: true, lastHeartbeatAt: '2026-08-12T00:00:00.000Z',
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } }),
  sequence: 2,
  serviceStartId: 'sidecar-1',
  now: () => new Date('2026-08-12T00:00:30.000Z'),
});
assert.deepEqual(concurrent, { skipped: 'integrated_heartbeat_active' });
assert.equal(concurrentCalls, 0);
await assert.rejects(
  () => runHeartbeatOnce({
    client: { async heartbeat() { throw new Error('must not send'); } },
    fetchImpl: async () => new Response('unavailable', { status: 503 }),
    sequence: 2,
    serviceStartId: 'sidecar-1',
  }),
  /health endpoint/i,
);

console.log('CLOUD_FAILOVER_HEARTBEAT_SIDECAR_TEST_OK');
