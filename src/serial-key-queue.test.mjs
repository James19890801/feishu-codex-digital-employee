import assert from 'node:assert/strict';
import { SerialKeyQueue } from './serial-key-queue.mjs';

{
  const queue = new SerialKeyQueue();
  const events = [];
  const first = queue.run('chat-1', async () => {
    events.push('first-start');
    await new Promise(resolve => setTimeout(resolve, 30));
    events.push('first-end');
  });
  const second = queue.run('chat-1', async () => {
    events.push('second');
  });
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first-start', 'first-end', 'second']);
  assert.equal(queue.size, 0);
}

{
  const queue = new SerialKeyQueue();
  await assert.rejects(queue.run('chat-2', async () => {
    throw new Error('expected');
  }), /expected/);
  assert.equal(queue.size, 0);
  await queue.run('chat-2', async () => {});
  assert.equal(queue.size, 0);
}

console.log('SERIAL_KEY_QUEUE_TEST_OK');
