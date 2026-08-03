import assert from 'node:assert/strict';
import {
  buildDingTalkHistoryArgs,
  formatConversationContext,
  normalizeConversationHistory,
} from './conversation-context.mjs';

assert.deepEqual(
  buildDingTalkHistoryArgs(
    { kind: 'direct', targetId: 'open-user' },
    { beforeTime: '2026-08-03 15:00:01', profile: 'corp:user' },
  ),
  [
    'chat', 'message', 'list', '--open-dingtalk-id', 'open-user',
    '--time', '2026-08-03 15:00:01', '--direction', 'older',
    '--limit', '30', '--format', 'json', '--profile', 'corp:user', '-y',
  ],
);

assert.deepEqual(
  buildDingTalkHistoryArgs(
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
  assert.throws(() => buildDingTalkHistoryArgs(context, options), pattern);
}

const manyMessages = Array.from({ length: 100 }, (_, index) => {
  const number = index + 1;
  const owner = number % 2 === 0;
  return {
    openMessageId: `m${number}`,
    openConversationId: 'cid-direct',
    senderOpenDingTalkId: owner ? 'owner-open' : 'colleague-open',
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
          openMessageId: 'old-1', senderOpenDingTalkId: 'owner-open', sender: '阿充',
          content: '之前的回复', createTime: '2026-08-03 14:59:00', openConversationId: 'cid-direct',
        },
        {
          openMessageId: 'old-1', senderOpenDingTalkId: 'owner-open', sender: '阿充',
          content: '之前的回复', createTime: '2026-08-03 14:59:00', openConversationId: 'cid-direct',
        },
        {
          openMessageId: 'system-1', senderOpenDingTalkId: 'system', sender: '系统',
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

const rawShape = normalizeConversationHistory(
  {
    messages: [{
      messageId: '', senderOpenDingTalkId: 'member-2', sender: '群友乙', content: '群里最后一句',
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
        openMessageId: 'owner-name-1', senderOpenDingTalkId: 'unknown-owner-open-id',
        sender: '冯周充', content: '我先看一下', createTime: '2026-08-03 14:59:00',
        openConversationId: 'cid-direct',
      }],
    },
  },
  {
    conversationId: 'cid-direct', ownerIds: ['384351'], ownerNames: ['阿充', '冯周充'],
    currentMessage: {
      messageId: 'owner-name-current', conversationId: 'cid-direct', senderId: 'colleague-open',
      senderName: '同事甲', content: '能帮我看看吗', createdAt: '2026-08-03 15:00:00',
    },
  },
);
assert.equal(ownerByName.styleSamples.length, 1);
assert.equal(ownerByName.styleSamples[0].content, '我先看一下');

const formatted = formatConversationContext(normalized);
assert.match(formatted, /当前钉钉会话最近 30 条真实消息/);
assert.match(formatted, /当前回应目标/);
assert.match(formatted, /同事甲：最后一句/);
assert.match(formatted, /阿充在本会话中的表达风格样本/);
assert.match(formatted, /阿充回复100/);

console.log('CONVERSATION_CONTEXT_TEST_OK');
