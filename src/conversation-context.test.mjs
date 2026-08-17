import assert from 'node:assert/strict';
import {
  buildEnterpriseChatHistoryArgs,
  formatConversationContext,
  normalizeConversationHistory,
} from './conversation-context.mjs';

assert.deepEqual(
  buildEnterpriseChatHistoryArgs(
    { kind: 'direct', targetId: 'open-user' },
    { beforeTime: '2026-08-03 15:00:01', profile: 'corp:user' },
  ),
  [
    'chat', 'message', 'list', '--user', 'open-user',
    '--time', '2026-08-03 15:00:01', '--direction', 'older',
    '--limit', '30', '--format', 'json', '--profile', 'corp:user', '-y',
  ],
);

assert.deepEqual(
  buildEnterpriseChatHistoryArgs(
    { kind: 'group', targetId: 'cid-group' },
    { beforeTime: '2026-08-03 15:00:01', profile: 'corp:user' },
  ),
  [
    'chat', 'message', 'list', '--group', 'cid-group',
    '--time', '2026-08-03 15:00:01', '--direction', 'older',
    '--limit', '30', '--format', 'json', '--profile', 'corp:user', '-y',
  ],
);

for (const [context, options, pattern] of [
  [{ kind: 'direct', targetId: '' }, { beforeTime: '2026-08-03 15:00:01', profile: 'corp:user' }, /target/i],
  [{ kind: 'thread', targetId: 'x' }, { beforeTime: '2026-08-03 15:00:01', profile: 'corp:user' }, /kind/i],
  [{ kind: 'direct', targetId: 'x' }, { beforeTime: '', profile: 'corp:user' }, /time/i],
  [{ kind: 'direct', targetId: 'x' }, { beforeTime: '2026-08-03 15:00:01', profile: '' }, /profile/i],
]) {
  assert.throws(() => buildEnterpriseChatHistoryArgs(context, options), pattern);
}

const manyMessages = Array.from({ length: 100 }, (_, index) => {
  const number = index + 1;
  const owner = number % 2 === 0;
  return {
    openMessageId: `m${number}`,
    openConversationId: 'cid-direct',
    senderEnterpriseUserId: owner ? 'owner-open' : 'colleague-open',
    sender: owner ? '阿充' : '同事甲',
    content: number === 99 ? '最后一句' : owner ? `阿充回复${number}` : `对方消息${number}`,
    createTime: `2026-08-03 15:${String(Math.floor((number - 1) / 60)).padStart(2, '0')}:${String((number - 1) % 60).padStart(2, '0')}`,
  };
}).reverse();

const normalized = normalizeConversationHistory(
  { success: true, result: { messages: manyMessages } },
  {
    conversationId: 'cid-direct',
    ownerIds: ['owner-open'],
    currentMessage: {
      messageId: 'm99',
      conversationId: 'cid-direct',
      senderId: 'colleague-open',
      senderName: '同事甲',
      content: '最后一句',
      createdAt: '2026-08-03 15:01:38',
    },
  },
);

assert.equal(normalized.messages.length, 30);
assert.equal(normalized.messages[0].messageId, 'm71');
assert.equal(normalized.messages[29].messageId, 'm100');
assert.equal(normalized.currentMessage.messageId, 'm99');
assert.equal(normalized.latestCounterpartyMessage.content, '最后一句');
assert.deepEqual(
  normalized.styleSamples.slice(0, 2).map(item => item.content),
  ['阿充回复100', '阿充回复98'],
);
assert.equal(normalized.styleSamples.length, 8);

const appended = normalizeConversationHistory(
  {
    data: {
      messages: [
        {
          openMessageId: 'old-1', senderEnterpriseUserId: 'owner-open', sender: '阿充',
          content: '之前的回复', createTime: '2026-08-03 14:59:00', openConversationId: 'cid-direct',
        },
        {
          openMessageId: 'old-1', senderEnterpriseUserId: 'owner-open', sender: '阿充',
          content: '之前的回复', createTime: '2026-08-03 14:59:00', openConversationId: 'cid-direct',
        },
        {
          openMessageId: 'system-1', senderEnterpriseUserId: 'system', sender: '系统',
          content: '[图片消息]', createTime: '2026-08-03 14:59:30', openConversationId: 'cid-direct',
        },
      ],
    },
  },
  {
    conversationId: 'cid-direct',
    ownerIds: ['owner-open'],
    currentMessage: {
      messageId: 'current-1', conversationId: 'cid-direct', senderId: 'colleague-open',
      senderName: '同事甲', content: '你看这个怎么做', createdAt: '2026-08-03 15:00:00',
    },
  },
);

assert.deepEqual(appended.messages.map(item => item.messageId), ['old-1', 'current-1']);
assert.equal(appended.currentMessage.messageId, 'current-1');
assert.equal(appended.latestCounterpartyMessage.content, '你看这个怎么做');

const withoutPassiveCallNotices = normalizeConversationHistory(
  {
    result: {
      messages: [
        {
          openMessageId: 'call-1', senderEnterpriseUserId: 'system', sender: '系统',
          content: '最近通话：00:21', createTime: '2026-08-03 14:57:00',
          openConversationId: 'cid-direct',
        },
        {
          openMessageId: 'call-2', senderEnterpriseUserId: 'system', sender: '系统',
          content: '未接来电：对方已挂断', createTime: '2026-08-03 14:58:00',
          openConversationId: 'cid-direct',
        },
        {
          openMessageId: 'call-3', senderEnterpriseUserId: 'owner-open', sender: '账号本人',
          content: '[语音通话] 已取消', createTime: '2026-08-03 14:59:00',
          openConversationId: 'cid-direct',
        },
        {
          openMessageId: 'real-1', senderEnterpriseUserId: 'owner-open', sender: '账号本人',
          content: '我稍后确认', createTime: '2026-08-03 14:59:30',
          openConversationId: 'cid-direct',
        },
      ],
    },
  },
  {
    conversationId: 'cid-direct', ownerIds: ['owner-open'],
    currentMessage: {
      messageId: 'current-call-filter', conversationId: 'cid-direct', senderId: 'colleague-open',
      senderName: '同事甲', content: '请帮我看一下', createdAt: '2026-08-03 15:00:00',
    },
  },
);
assert.deepEqual(
  withoutPassiveCallNotices.messages.map(item => item.messageId),
  ['real-1', 'current-call-filter'],
);
assert.deepEqual(withoutPassiveCallNotices.styleSamples.map(item => item.content), ['我稍后确认']);

const rawShape = normalizeConversationHistory(
  {
    messages: [{
      messageId: '', senderEnterpriseUserId: 'member-2', sender: '群友乙', content: '群里最后一句',
      createTime: '2026-08-03 15:00:00', openConversationId: 'cid-group',
    }],
  },
  {
    conversationId: 'cid-group', ownerIds: ['owner-open'],
    currentMessage: {
      messageId: 'group-current', conversationId: 'cid-group', senderId: 'member-2',
      senderName: '群友乙', content: '群里最后一句', createdAt: '2026-08-03 15:00:00',
    },
  },
);
assert.equal(rawShape.messages.length, 1);
assert.equal(rawShape.latestCounterpartyMessage.senderName, '群友乙');

const ownerByName = normalizeConversationHistory(
  {
    result: {
      messages: [{
        openMessageId: 'owner-name-1', senderEnterpriseUserId: 'unknown-owner-open-id',
        sender: '冯周充', content: '我先看一下', createTime: '2026-08-03 14:59:00',
        openConversationId: 'cid-direct',
      }],
    },
  },
  {
    conversationId: 'cid-direct', ownerIds: ['owner-demo'], ownerNames: ['阿充', '冯周充'],
    currentMessage: {
      messageId: 'owner-name-current', conversationId: 'cid-direct', senderId: 'colleague-open',
      senderName: '同事甲', content: '能帮我看看吗', createdAt: '2026-08-03 15:00:00',
    },
  },
);
assert.equal(ownerByName.styleSamples.length, 1);
assert.equal(ownerByName.styleSamples[0].content, '我先看一下');

const providerConversationId = normalizeConversationHistory(
  {
    result: {
      messages: [{
        openMessageId: 'provider-old', openConversationId: 'provider-cid-direct',
        senderEnterpriseUserId: 'owner-open', sender: '冯周充', content: '历史回复',
        createTime: '2026-08-03 14:59:00',
      }],
    },
  },
  {
    conversationId: 'enterpriseChat:user:colleague-open', ownerIds: ['owner-open'], ownerNames: ['冯周充'],
    currentMessage: {
      messageId: 'logical-current', conversationId: 'enterpriseChat:user:colleague-open',
      senderId: 'colleague-open', senderName: '同事甲', content: '当前问题',
      createdAt: '2026-08-03 15:00:00',
    },
  },
);
assert.deepEqual(
  providerConversationId.messages.map(item => item.messageId),
  ['provider-old', 'logical-current'],
);
assert.equal(providerConversationId.messages[0].conversationId, 'enterpriseChat:user:colleague-open');

const formatted = formatConversationContext(normalized, { ownerLabel: '新用户' });
assert.match(formatted, /当前企业会话会话最近 30 条真实消息/);
assert.match(formatted, /当前回应目标/);
assert.match(formatted, /同事甲：最后一句/);
assert.match(formatted, /新用户在本会话中的表达风格样本/);
assert.match(formatted, /阿充回复100/);
assert.doesNotMatch(formatted, /阿充在本会话/);

console.log('CONVERSATION_CONTEXT_TEST_OK');
