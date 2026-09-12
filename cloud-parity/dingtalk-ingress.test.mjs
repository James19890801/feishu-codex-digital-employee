import assert from 'node:assert/strict';
import test from 'node:test';
import { DingTalkIngress } from './dingtalk-ingress.mjs';

function event(type = 'user_im_message_receive_at') {
  return { type, message_id: 'mid-1', sender_open_dingtalk_id: 'user-1',
    conversation_id: 'group-1', content: '@小詹 测试', create_time: 1_800_000_000_000 };
}

test('normalizes independent DingTalk stream and deduplicates by provider message ID', async () => {
  const events = new Map();
  const store = { enqueue: async input => {
    const duplicate = events.has(input.digest);
    events.set(input.digest, input);
    return { accepted: true, duplicate };
  } };
  const ingress = new DingTalkIngress({ store, now: () => 1_800_000_000_100 });
  const first = await ingress.acceptLine(JSON.stringify(event()));
  const repeated = await ingress.acceptLine(JSON.stringify(event('user_im_message_receive_group_all')));
  assert.equal(first.accepted, true);
  assert.equal(repeated.duplicate, true);
  assert.equal(events.size, 1);
  const queued = JSON.parse([...events.values()][0].body);
  assert.equal(queued.message.message_id, 'dingtalk:mid-1');
  assert.equal(queued.message.chat_id, 'dingtalk:group:group-1');
});

test('ignores non-message events but fails on malformed and oversized input', async () => {
  const ingress = new DingTalkIngress({ store: { enqueue: async () => { throw Error('unexpected'); } } });
  assert.deepEqual(await ingress.acceptLine(JSON.stringify({ type: 'other' })), { accepted: false, reason: 'irrelevant' });
  await assert.rejects(ingress.acceptLine('{'), /invalid_dingtalk_json/);
  await assert.rejects(ingress.acceptLine('a'.repeat(1_048_577)), /dingtalk_event_too_large/);
});

test('never acknowledges a DingTalk event when durable enqueue fails', async () => {
  const ingress = new DingTalkIngress({ store: { enqueue: async () => { throw Error('disk full'); } } });
  await assert.rejects(ingress.acceptLine(JSON.stringify(event())), /disk full/);
});
