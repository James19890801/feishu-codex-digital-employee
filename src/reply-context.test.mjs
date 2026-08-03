import assert from 'node:assert/strict';
import {
  ReplyContextService,
  ReplyContextUnavailableError,
  buildDingTalkReplyHistoryRequest,
  buildReplyContextInstruction,
} from './reply-context.mjs';

const directRequest = buildDingTalkReplyHistoryRequest({
  message: {
    message_id: 'dingtalk:msg-2', chat_id: 'dingtalk:user:colleague-open', chat_type: 'p2p',
    create_time: String(Date.parse('2026-08-03T07:00:00.000Z')),
  },
  senderOpenId: 'dingtalk:colleague-open',
  cleanText: '这个岗位招一个6，你怎么看',
  metadata: { channel: 'dingtalk', senderName: '同事甲' },
});
assert.deepEqual(directRequest, {
  kind: 'direct',
  targetId: 'colleague-open',
  beforeTime: '2026-08-03 15:00:01',
  conversationId: 'dingtalk:user:colleague-open',
  currentMessage: {
    messageId: 'dingtalk:msg-2',
    conversationId: 'dingtalk:user:colleague-open',
    senderId: 'colleague-open',
    senderName: '同事甲',
    content: '这个岗位招一个6，你怎么看',
    createdAt: '2026-08-03 15:00:00',
  },
});

const groupRequest = buildDingTalkReplyHistoryRequest({
  message: {
    message_id: 'dingtalk:group-msg', chat_id: 'dingtalk:group:cid-group', chat_type: 'group',
    create_time: String(Date.parse('2026-08-03T07:00:00.000Z')),
  },
  senderOpenId: 'dingtalk:member-open',
  cleanText: '@阿充 看一下',
  metadata: { channel: 'dingtalk', senderName: '群友乙' },
});
assert.equal(groupRequest.kind, 'group');
assert.equal(groupRequest.targetId, 'cid-group');
assert.equal(groupRequest.currentMessage.senderId, 'member-open');

assert.throws(
  () => buildDingTalkReplyHistoryRequest({
    message: { message_id: 'x', chat_id: 'wecom:user:u1', chat_type: 'p2p', create_time: '1' },
    senderOpenId: 'u1', cleanText: 'x', metadata: {},
  }),
  /DingTalk/i,
);

const normalizedContext = {
  messages: [
    {
      messageId: 'm1', senderId: 'owner', senderName: '冯周充', direction: 'owner',
      content: '我先看下', createdAt: '2026-08-03 14:59:00', createdAtMs: 1,
    },
    {
      messageId: 'm2', senderId: 'other', senderName: '同事甲', direction: 'counterparty',
      content: '这个岗位招一个6，你怎么看', createdAt: '2026-08-03 15:00:00', createdAtMs: 2,
    },
  ],
  currentMessage: {
    messageId: 'm2', senderId: 'other', senderName: '同事甲', direction: 'counterparty',
    content: '这个岗位招一个6，你怎么看', createdAt: '2026-08-03 15:00:00', createdAtMs: 2,
  },
  latestCounterpartyMessage: {
    messageId: 'm2', senderId: 'other', senderName: '同事甲', direction: 'counterparty',
    content: '这个岗位招一个6，你怎么看', createdAt: '2026-08-03 15:00:00', createdAtMs: 2,
  },
  styleSamples: [{
    messageId: 'm1', senderId: 'owner', senderName: '冯周充', direction: 'owner',
    content: '我先看下', createdAt: '2026-08-03 14:59:00', createdAtMs: 1,
  }],
};

const service = new ReplyContextService({
  contextClient: { fetch: async () => normalizedContext },
  ownerLabel: '新用户',
});
const prepared = await service.prepare({
  task: '这个岗位招一个6，你怎么看',
  historyRequest: { kind: 'direct', targetId: 'other' },
});

assert.match(prepared.historyPrompt, /最近 30 条真实消息/);
assert.equal(prepared.currentTarget, '这个岗位招一个6，你怎么看');
assert.match(prepared.stylePrompt, /我先看下/);
assert.match(prepared.stylePrompt, /新用户：/);
assert.doesNotMatch(prepared.historyPrompt, /阿充在本会话/);
assert.match(prepared.languagePrompt, /P6/);

const instruction = buildReplyContextInstruction(prepared, { ownerLabel: '新用户' });
assert.match(instruction, /先回应“当前回应目标”/);
assert.match(instruction, /这个岗位招一个6/);
assert.match(instruction, /P6/);
assert.match(instruction, /模仿表达方式但不复制承诺、隐私或历史事实/);
assert.match(instruction, /风格样本只来自新用户本人/);

const failingService = new ReplyContextService({
  contextClient: { fetch: async () => { throw new Error('DWS auth expired'); } },
  ownerLabel: '新用户',
});
await assert.rejects(
  failingService.prepare({ task: '你好', historyRequest: {} }),
  error => error instanceof ReplyContextUnavailableError
    && error.code === 'CONVERSATION_HISTORY_UNAVAILABLE'
    && /DWS auth expired/.test(error.message),
);

console.log('REPLY_CONTEXT_TEST_OK');
