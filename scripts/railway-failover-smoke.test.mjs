import assert from 'node:assert/strict';
import { runRailwayFailoverSmoke } from './railway-failover-smoke.mjs';

await assert.rejects(() => runRailwayFailoverSmoke({
  railwayUrl: '', coordinatorUrl: 'https://coordinator.test', token: 'secret',
}), /RAILWAY_PUBLIC_URL/);

const calls = [];
const result = await runRailwayFailoverSmoke({
  railwayUrl: 'https://railway.test/',
  coordinatorUrl: 'https://coordinator.test/',
  token: 'runtime-secret',
  fetchImpl: async (url, init = {}) => {
    calls.push([url, init]);
    if (url === 'https://railway.test/live') {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    assert.equal(url, 'https://coordinator.test/internal/runtime/lease');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.authorization, 'Bearer runtime-secret');
    return new Response(JSON.stringify({ ok: true, state: 'LOCAL_PRIMARY', generation: 2 }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  },
});
assert.deepEqual(result, {
  ok: true,
  railway: { live: true },
  coordinator: { state: 'LOCAL_PRIMARY', generation: 2 },
});
assert.equal(calls.length, 2);
assert.doesNotMatch(JSON.stringify(result), /runtime-secret/);
console.log('RAILWAY_FAILOVER_SMOKE_TEST_OK');
