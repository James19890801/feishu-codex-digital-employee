import assert from 'node:assert/strict';
import { FailoverHeartbeat } from './failover-heartbeat.mjs';

const timers = [];
const cleared = [];
const successes = [];
const errors = [];
let resolveHeartbeat;
let calls = 0;
const heartbeat = new FailoverHeartbeat({
  client: {
    heartbeat: async payload => {
      calls += 1;
      assert.deepEqual(payload, {
        sequence: calls,
        at: '2026-08-07T00:00:00.000Z',
        serviceStartId: 'start-1',
        connectorConnected: true,
        runtimeHealthy: true,
        lastMessageDigest: 'a'.repeat(64),
        appVersion: '1.0.0',
        protocolVersion: '1',
      });
      if (calls === 1) {
        await new Promise(resolve => { resolveHeartbeat = resolve; });
      }
      if (calls === 2) throw new Error('gateway unavailable');
      return { state: 'LOCAL_PRIMARY', generation: 0 };
    },
  },
  intervalMs: 30_000,
  snapshot: sequence => ({
    sequence,
    at: '2026-08-07T00:00:00.000Z',
    serviceStartId: 'start-1',
    connectorConnected: true,
    runtimeHealthy: true,
    lastMessageDigest: 'a'.repeat(64),
    appVersion: '1.0.0',
    protocolVersion: '1',
  }),
  onSuccess: result => successes.push(result),
  onError: error => errors.push(error.message),
  setTimer: (callback, delayMs) => {
    const timer = { callback, delayMs };
    timers.push(timer);
    return timer;
  },
  clearTimer: timer => cleared.push(timer),
});

heartbeat.start();
assert.equal(timers.length, 1);
assert.equal(timers[0].delayMs, 0);
const firstTick = timers[0].callback();
assert.equal(calls, 1);
assert.equal(timers.length, 1, 'next heartbeat must not schedule while the first is running');
resolveHeartbeat();
await firstTick;
assert.equal(successes.length, 1);
assert.equal(timers.length, 2);
assert.equal(timers[1].delayMs, 30_000);

await timers[1].callback();
assert.equal(errors[0], 'gateway unavailable');
assert.equal(timers.length, 3, 'a failed heartbeat must keep the local loop alive');

heartbeat.stop();
assert.equal(cleared.at(-1), timers[2]);
await timers[2].callback();
assert.equal(calls, 2, 'stopped heartbeat must not call the gateway');

console.log('FAILOVER_HEARTBEAT_TEST_OK');
