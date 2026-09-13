import assert from 'node:assert/strict';
import test from 'node:test';
import { createChannelSenders } from './channel-send.mjs';

const intentKey = 'a'.repeat(64);
const wechatEvent = { message: { chat_id: 'wechat:user:wxid_friend', chat_type: 'p2p' },
  sender: { sender_id: { open_id: 'wechat:wxid_friend' } } };
const dingtalkEvent = { message: { chat_id: 'dingtalk:user:ou_friend', chat_type: 'p2p' },
  sender: { sender_id: { open_id: 'dingtalk:ou_friend' } } };

test('WeChat sender requires an actual provider message ID', async () => {
  const calls = [];
  const senders = createChannelSenders({
    gewe: { send: async (...args) => { calls.push(args); return { ret: 200, data: { newMsgId: 'wx-1' } }; } },
    dws: { send: async () => ({ success: true, result: { openMessageId: 'unused' } }) },
  });
  const receipt = await senders.wechat.send({ event: wechatEvent, text: '你好', intentKey });
  assert.equal(receipt.receiptId, 'wx-1');
  assert.equal(calls[0][0].id, 'wxid_friend');
  assert.equal(calls[0][1], '你好');
  const missing = createChannelSenders({ gewe: { send: async () => ({ ret: 200, data: {} }) },
    dws: { send: async () => ({}) } });
  assert.deepEqual(await missing.wechat.send({ event: wechatEvent, text: '你好', intentKey }), {});
});

test('WeChat-only provider construction does not require DingTalk credentials', async () => {
  const senders = createChannelSenders({ gewe: {
    send: async () => ({ ret: 200, data: { newMsgId: 'wechat-real-id' } }),
  }, channels: ['wechat'] });
  const receipt = await senders.wechat.send({ event: wechatEvent, text: '你好',
    intentKey: 'a'.repeat(64) });
  assert.equal(receipt.receiptId, 'wechat-real-id');
  assert.equal(Object.hasOwn(senders, 'dingtalk'), false);
});

test('DingTalk sender passes stable UUID and does not mistake openTaskId for sent receipt', async () => {
  const calls = [];
  const senders = createChannelSenders({
    gewe: { send: async () => ({}) },
    dws: { send: async (...args) => { calls.push(args); return { success: true,
      result: { openMessageId: 'ding-1' } }; } },
  });
  const receipt = await senders.dingtalk.send({ event: dingtalkEvent, text: '收到', intentKey });
  assert.equal(receipt.receiptId, 'ding-1');
  assert.equal(calls[0][2], intentKey);
  const pending = createChannelSenders({ gewe: { send: async () => ({}) },
    dws: { send: async () => ({ success: true, result: { openTaskId: 'task-only' } }) } });
  assert.deepEqual(await pending.dingtalk.send({ event: dingtalkEvent, text: '收到', intentKey }), {});
});

test('group reply fails closed when native mention cannot be generated', async () => {
  const senders = createChannelSenders({
    gewe: { send: async () => { throw Error('should not send'); } },
    dws: { send: async () => { throw Error('should not send'); } },
  });
  await assert.rejects(senders.wechat.send({ event: {
    message: { chat_id: 'wechat:group:room@chatroom', chat_type: 'group' },
    sender: { sender_id: { open_id: 'wechat:wxid_sender' } },
  }, text: '你好', intentKey }), /mention_unavailable/);
});
