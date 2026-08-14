import assert from 'node:assert/strict';
import { RailwayFailoverRuntime, computeBackoffMs } from './runtime.mjs';

assert.equal(computeBackoffMs(0, { jitter: () => 0 }), 10_000);
assert.equal(computeBackoffMs(1, { jitter: () => 0 }), 20_000);
assert.equal(computeBackoffMs(9, { jitter: () => 0 }), 60_000);

const leases = [
  { state: 'TAKING_OVER', generation: 4 },
  { state: 'CLOUD_ACTIVE', generation: 4 },
  { state: 'DRAINING', generation: 4 },
  { state: 'LOCAL_PRIMARY', generation: 4 },
];
const calls = [];
const worker = {
  activeGeneration: 0,
  async initialize() { calls.push(['initialize']); },
  async activate(generation, options) {
    calls.push(['activate', generation, options]);
    this.activeGeneration = generation;
  },
  deactivate() { calls.push(['deactivate']); this.activeGeneration = 0; },
};
const coordinator = { async lease() { return leases.shift(); } };
const runtime = new RailwayFailoverRuntime({ worker, coordinator });
await runtime.tick();
assert.deepEqual(calls.at(-1), ['activate', 4, { announceReady: true }]);
await runtime.tick();
assert.equal(calls.filter(call => call[0] === 'activate').length, 1);
await runtime.tick();
assert.equal(worker.activeGeneration, 0);
await runtime.tick();
assert.equal(worker.activeGeneration, 0);

const failedWorker = {
  activeGeneration: 0,
  async initialize() {},
  async activate() { throw new Error('must not activate'); },
  deactivate() {},
};
const failedRuntime = new RailwayFailoverRuntime({
  worker: failedWorker,
  coordinator: { async lease() { throw new Error('network'); } },
});
await assert.rejects(() => failedRuntime.tick(), /network/);
assert.equal(failedWorker.activeGeneration, 0);
console.log('FAILOVER_RAILWAY_RUNTIME_TEST_OK');
