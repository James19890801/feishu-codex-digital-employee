import assert from 'node:assert/strict';
import { runCloudFailoverSmoke } from './cloud-failover-smoke.mjs';

const calls = [];
const result = await runCloudFailoverSmoke({
  async heartbeat(input) { calls.push(['heartbeat', input]); return { state: 'LOCAL_PRIMARY', generation: 2 }; },
  async execute(input) { calls.push(['execute', input]); return { text: 'AIPR0S_CLOUD_OK', sessionId: 'sess', latencyMs: 42 }; },
}, () => new Date('2026-08-07T00:00:00.000Z'));
assert.deepEqual(result, {
  ok: true, state: 'LOCAL_PRIMARY', generation: 2, sessionId: 'sess', latencyMs: 42,
});
assert.equal(calls[1][1].level, 'L0');
assert.equal(calls[1][1].prompt, '只回复 AIPR0S_CLOUD_OK');
console.log('CLOUD_FAILOVER_SMOKE_TEST_OK');
