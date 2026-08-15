import assert from 'node:assert/strict';
import * as replyRouting from './reply-routing.mjs';
import {
  createReplyContext,
  resolveReplyMentionSenderIds,
} from './reply-routing.mjs';

assert.equal(
  typeof replyRouting.assertRequiredReplyMention,
  'function',
  'the send route needs a fail-closed required-mention guard',
);

const groupContext = createReplyContext({
  message: { chat_id: 'dingtalk:group:cid-1', chat_type: 'group' },
  senderId: 'dingtalk:requester-1',
});
assert.deepEqual(groupContext, {
  chatId: 'dingtalk:group:cid-1',
  chatType: 'group',
  senderIds: ['dingtalk:requester-1'],
  mentionRequired: true,
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

assert.equal(createReplyContext({
  message: { chat_id: 'wechat:user:wxid_friend', chat_type: 'p2p' },
  senderId: 'wechat:wxid_friend',
}).mentionRequired, false, 'direct replies must not require @ mentions');

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

if (typeof replyRouting.assertRequiredReplyMention === 'function') {
  assert.doesNotThrow(() => replyRouting.assertRequiredReplyMention({
    chatId: 'wechat:group:room@chatroom',
    chatType: 'group',
    senderIds: ['wechat:wxid_member'],
    context: {
      chatId: 'wechat:group:room@chatroom',
      chatType: 'group',
      senderIds: ['wechat:wxid_member'],
      mentionRequired: true,
    },
  }));
  assert.throws(() => replyRouting.assertRequiredReplyMention({
    chatId: 'wechat:group:room@chatroom',
    chatType: 'group',
    senderIds: [],
    context: {
      chatId: 'wechat:group:room@chatroom',
      chatType: 'group',
      senderIds: ['wechat:wxid_member'],
      mentionRequired: true,
    },
  }), /required.*mention|必须.*@/iu, 'required mentions must fail closed');
}

console.log('REPLY_ROUTING_TEST_OK');
