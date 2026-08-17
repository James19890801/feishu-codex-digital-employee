import assert from 'node:assert/strict';
import { createShutdownGuard } from './shutdown-guard.mjs';

{
  const exits = [];
  const logs = [];
  const timers = [];
  const cleared = [];
  const guard = createShutdownGuard({
    timeoutMs: 15_000,
    setTimeoutImpl: (callback, timeoutMs) => {
      const timer = { callback, timeoutMs, unrefCalled: false, unref() { this.unrefCalled = true; } };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl: timer => { cleared.push(timer); },
    forceExit: code => { exits.push(code); },
    log: message => { logs.push(message); },
  });
  assert.equal(guard.start('SIGTERM'), true);
  assert.equal(guard.start('SIGINT'), false);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].timeoutMs, 15_000);
  assert.equal(timers[0].unrefCalled, true);
  timers[0].callback();
  timers[0].callback();
  assert.deepEqual(exits, [1]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /SIGTERM/);
  guard.complete();
  assert.equal(cleared.length, 1);
}

{
  const exits = [];
  let callback = null;
  let cleared = false;
  const guard = createShutdownGuard({
    timeoutMs: 50,
    setTimeoutImpl: operation => {
      callback = operation;
      return { unref() {} };
    },
    clearTimeoutImpl: () => { cleared = true; },
    forceExit: code => { exits.push(code); },
  });
  guard.start('SIGTERM');
  guard.complete();
  assert.equal(cleared, true);
  callback();
  assert.deepEqual(exits, []);
}

console.log('SHUTDOWN_GUARD_TEST_OK');
