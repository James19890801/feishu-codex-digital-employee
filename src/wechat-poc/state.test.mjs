import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WeChatPocState } from './state.mjs';

const directory = await mkdtemp(join(tmpdir(), 'aipro-wechat-state-'));
const databasePath = join(directory, 'state.sqlite');
const event = {
  messageId: 'abc123',
  chatId: 'wechat-poc:user:0123456789abcdef0123456789abcdef',
  senderId: 'sender-hash',
  conversationKind: 'direct',
  conversationTitle: '受控测试联系人',
  senderName: '受控测试联系人',
  text: '在吗？',
  observedAt: '2026-08-01T03:00:00.000Z',
};

const state = new WeChatPocState(databasePath);
try {
  assert.equal(state.recordObservation(event.messageId, event), true);
  assert.equal(state.recordObservation(event.messageId, event), false);
  assert.equal(state.wasObserved(event.messageId), true);

  assert.equal(state.enqueue(event.messageId, event, 2), true);
  assert.equal(state.enqueue(event.messageId, event, 2), false);
  assert.deepEqual(state.statusCounts(), { pending: 1 });

  const claimed = state.claimNext();
  assert.equal(claimed.messageId, event.messageId);
  assert.equal(claimed.generation, 2);
  assert.equal(state.statusCounts().processing, 1);
  state.markUncertain(event.messageId, 'send result unavailable');
  assert.equal(state.statusCounts().uncertain, 1);

  const second = { ...event, messageId: 'def456', text: '第二条' };
  state.recordObservation(second.messageId, second);
  state.enqueue(second.messageId, second, 2);
  assert.equal(state.cancelBeforeGeneration(3, 'switch_disabled'), 1);
  assert.equal(state.statusCounts().cancelled, 1);

  state.remember(event.chatId, event.senderId, 'user', '你好');
  state.remember(event.chatId, event.senderId, 'assistant', '我在');
  assert.deepEqual(state.history(event.chatId, event.senderId, 2), [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '我在' },
  ]);

  state.audit('poc_test', {
    chatId: event.chatId,
    messageId: event.messageId,
    detail: { reason: 'controlled' },
  });
  const latest = state.recentAudit(1)[0];
  assert.equal(latest.event, 'poc_test');
  assert.deepEqual(latest.detail, { reason: 'controlled' });

  console.log('WECHAT_POC_STATE_TEST_OK');
} finally {
  state.close();
  await rm(directory, { recursive: true, force: true });
}
