import assert from 'node:assert/strict';
import {
  createReplyContext,
  resolveReplyMentionSenderIds,
} from './reply-routing.mjs';

const groupContext = createReplyContext({
  message: { chat_id: 'dingtalk:group:cid-1', chat_type: 'group' },
  senderId: 'dingtalk:requester-1',
});
assert.deepEqual(groupContext, {
  chatId: 'dingtalk:group:cid-1',
  chatType: 'group',
  senderIds: ['dingtalk:requester-1'],
});
assert.deepEqual(resolveReplyMentionSenderIds({
  chatId: 'dingtalk:group:cid-1',
  chatType: 'group',
  context: groupContext,
}), ['dingtalk:requester-1'], 'a group reply must @ the current requester by default');

assert.deepEqual(resolveReplyMentionSenderIds({
  chatId: 'dingtalk:user:requester-1',
  chatType: 'p2p',
  context: {
    chatId: 'dingtalk:user:requester-1',
    chatType: 'p2p',
    senderIds: ['dingtalk:requester-1'],
  },
}), [], 'direct replies must not add @ mentions');

assert.deepEqual(resolveReplyMentionSenderIds({
  chatId: 'oc_group',
  chatType: 'group',
  explicitSenderIds: ['ou_a', 'ou_b', 'ou_a', '', 'ou_c'],
  context: { chatId: 'oc_group', chatType: 'group', senderIds: ['ou_requester'] },
}), ['ou_a', 'ou_b', 'ou_c'], 'explicit multi-recipient routing must be deduplicated');

assert.deepEqual(resolveReplyMentionSenderIds({
  chatId: 'oc_other',
  chatType: 'group',
  context: { chatId: 'oc_group', chatType: 'group', senderIds: ['ou_requester'] },
}), [], 'reply context must never leak into another chat');

console.log('REPLY_ROUTING_TEST_OK');
