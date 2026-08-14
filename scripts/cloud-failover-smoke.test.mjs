import assert from 'node:assert/strict';
import { runCloudFailoverSmoke } from './cloud-failover-smoke.mjs';

const calls = [];
const result = await runCloudFailoverSmoke({
  async heartbeat(input) { calls.push(['heartbeat', input]); return { state: 'LOCAL_PRIMARY', generation: 2 }; },
  async execute(input) {
    calls.push(['execute', input]);
    const replayed = calls.filter(([kind]) => kind === 'execute').length > 1;
    return {
      text: 'AIPR0S_CLOUD_OK', sessionId: 'sess', latencyMs: 42,
      handoff: { status: 'completed', replayed },
    };
  },
}, () => new Date('2026-08-07T00:00:00.000Z'));
assert.deepEqual(result, {
  ok: true, state: 'LOCAL_PRIMARY', generation: 2, sessionId: 'sess', latencyMs: 42,
  handoffReplayed: true,
});
assert.equal(calls[1][1].level, 'L0');
assert.equal(calls[1][1].prompt, '只回复 AIPR0S_CLOUD_OK');
assert.equal(calls[1][1].handoffKey, 'manual-smoke:2026-08-07T00:00:00.000Z');
assert.equal(calls[2][1].handoffKey, calls[1][1].handoffKey);
console.log('CLOUD_FAILOVER_SMOKE_TEST_OK');
