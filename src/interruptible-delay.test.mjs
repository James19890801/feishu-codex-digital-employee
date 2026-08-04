import assert from 'node:assert/strict';
import { InterruptibleDelay } from './interruptible-delay.mjs';

{
  const delay = new InterruptibleDelay();
  const startedAt = Date.now();
  const waiting = delay.wait(10_000);
  setTimeout(() => delay.stop(), 30);
  await waiting;
  assert.equal(Date.now() - startedAt < 500, true);
  await delay.wait(10_000);
  assert.equal(delay.stopped, true);
}

console.log('INTERRUPTIBLE_DELAY_TEST_OK');
