import assert from 'node:assert/strict';
import {
  buildHeartbeatSnapshot,
  runHeartbeatOnce,
} from './cloud-failover-heartbeat-sidecar.mjs';

const healthyStatus = {
  healthy: true,
  process: { alive: true },
  aiRuntime: { healthy: true },
  channels: { enterpriseChat: { authenticated: true, connected: true } },
};
assert.deepEqual(buildHeartbeatSnapshot(healthyStatus, {
  sequence: 2,
  at: '2026-08-12T00:00:00.000Z',
  serviceStartId: 'sidecar-1',
}), {
  sequence: 2,
  at: '2026-08-12T00:00:00.000Z',
  serviceStartId: 'sidecar-1',
  connectorConnected: true,
  runtimeHealthy: true,
  lastMessageDigest: '',
  appVersion: '1.0.0-sidecar',
  protocolVersion: '1',
});

const unhealthy = buildHeartbeatSnapshot({
  ...healthyStatus,
  aiRuntime: { healthy: false },
}, { sequence: 3, at: '2026-08-12T00:00:30.000Z', serviceStartId: 'sidecar-1' });
assert.equal(unhealthy.connectorConnected, true);
assert.equal(unhealthy.runtimeHealthy, false);

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
