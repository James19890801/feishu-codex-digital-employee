import assert from 'node:assert/strict';
import {
  messageFingerprint,
  normalizeObservedMessage,
  wechatChatId,
} from './message-policy.mjs';

const base = {
  conversationTitle: '受控测试联系人',
  conversationKind: 'direct',
  senderName: '受控测试联系人',
  direction: 'incoming',
  contentType: 'text',
  text: '在吗？',
  observedAt: '2026-08-01T03:00:00.000Z',
};

const direct = normalizeObservedMessage(base);
assert.equal(direct.accepted, true);
assert.equal(direct.event.conversationKind, 'direct');
assert.equal(direct.event.text, '在吗？');

const groupIgnored = normalizeObservedMessage({
  ...base,
  conversationTitle: '受控测试群',
  conversationKind: 'group',
  mentionedSelf: false,
});
assert.equal(groupIgnored.accepted, false);
assert.equal(groupIgnored.reason, 'group_without_mention');

const groupMention = normalizeObservedMessage({
  ...base,
  conversationTitle: '受控测试群',
  conversationKind: 'group',
  mentionedSelf: true,
  text: '@詹老师 测试一下',
});
assert.equal(groupMention.accepted, true);

for (const observation of [
  { ...base, direction: 'outgoing' },
  { ...base, direction: 'self' },
  { ...base, text: '   ' },
  { ...base, contentType: 'image' },
  { ...base, contentType: 'system', text: '你撤回了一条消息' },
  { ...base, text: '[红包]' },
  { ...base, text: '转账 ￥100.00' },
  { ...base, text: '对方撤回了一条消息' },
]) {
  assert.equal(normalizeObservedMessage(observation).accepted, false);
}

const fingerprint = messageFingerprint(direct.event);
assert.equal(fingerprint, messageFingerprint(direct.event));
assert.match(fingerprint, /^[a-f0-9]{64}$/);
assert.equal(fingerprint.includes('受控测试联系人'), false);
assert.equal(fingerprint.includes('在吗'), false);
assert.equal(
  messageFingerprint({ ...direct.event, sourceMessageId: 'row-1', observedAt: '2026-08-01T03:00:00Z' }),
  messageFingerprint({ ...direct.event, sourceMessageId: 'row-1', observedAt: '2026-08-01T03:01:00Z' }),
);

const chatId = wechatChatId(direct.event);
assert.match(chatId, /^wechat-poc:user:[a-f0-9]{32}$/);
assert.equal(chatId.includes('受控测试联系人'), false);
assert.match(wechatChatId(groupMention.event), /^wechat-poc:group:[a-f0-9]{32}$/);

console.log('WECHAT_POC_MESSAGE_POLICY_TEST_OK');
