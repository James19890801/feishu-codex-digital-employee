import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StandbyMessageBuffer } from './standby-buffer.mjs';

const root = await mkdtemp(join(tmpdir(), 'aipros-standby-buffer-test-'));
const now = 1_786_060_800_000;
const options = {
  path: join(root, 'standby.sqlite'), secret: 'container-token-for-tests', nodeId: 'railway-node-1',
  now: () => now, ttlMs: 180_000, maxRows: 100,
};
const message = {
  messageId: 'm-1', chatId: 'chat-1', senderId: 'user-1', text: '你好', createdAt: now,
  messageType: 'text', chatType: 'p2p',
};

try {
  const first = await StandbyMessageBuffer.open(options);
  assert.equal(await first.put(message), true);
  assert.equal(await first.put(message), false);
  await first.close();

  const second = await StandbyMessageBuffer.open(options);
  assert.equal((await second.list()).length, 1);
  const handled = [];
  assert.deepEqual(await second.drain({ now, handler: async item => handled.push(item.messageId) }), {
    completed: 1, failed: 0, remaining: 0,
  });
  assert.deepEqual(handled, ['m-1']);
  assert.equal((await second.list()).length, 0);
  await second.close();

  const bounded = await StandbyMessageBuffer.open({ ...options, path: join(root, 'bounded.sqlite') });
  for (let index = 0; index < 101; index += 1) {
    await bounded.put({ ...message, messageId: `bounded-${index}`, createdAt: now - 100 + index });
  }
  const boundedRows = await bounded.list();
  assert.equal(boundedRows.length, 100);
  assert.equal(boundedRows[0].messageId, 'bounded-1');
  await bounded.close();

  const expiry = await StandbyMessageBuffer.open({ ...options, path: join(root, 'expiry.sqlite') });
  await expiry.put({ ...message, messageId: 'expired', createdAt: now - 180_001 });
  await expiry.put({ ...message, messageId: 'current' });
  assert.equal((await expiry.list()).length, 1);
  assert.equal((await expiry.prune(now + 180_001)), 1);
  assert.equal((await expiry.list()).length, 0);
  await expiry.close();

  const retained = await StandbyMessageBuffer.open({ ...options, path: join(root, 'retained.sqlite') });
  await retained.put({ ...message, messageId: 'retain-me' });
  assert.deepEqual(await retained.drain({ now, handler: async () => { throw new Error('temporary'); } }), {
    completed: 0, failed: 1, remaining: 1,
  });
  assert.equal((await retained.list()).length, 1);
  await retained.close();

  const encryptedPath = join(root, 'wrong-key.sqlite');
  const encrypted = await StandbyMessageBuffer.open({ ...options, path: encryptedPath });
  await encrypted.put({ ...message, messageId: 'secret-row' });
  await encrypted.close();
  const wrongKey = await StandbyMessageBuffer.open({ ...options, path: encryptedPath, secret: 'wrong-container-token' });
  await assert.rejects(() => wrongKey.list(), /decrypt|authenticate/i);
  await wrongKey.close();

  console.log('STANDBY_MESSAGE_BUFFER_TEST_OK');
} finally {
  await rm(root, { recursive: true, force: true });
}
