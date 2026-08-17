import assert from 'node:assert/strict';
import { enrichWeChatLearningContext } from './wechat-learning-context.mjs';

const values = new Map();
const audits = [];
const state = {
  get(scope, key, fallback) { return values.get(`${scope}:${key}`) ?? fallback; },
  set(scope, key, value) { values.set(`${scope}:${key}`, value); },
  audit(event, payload) { audits.push({ event, payload }); },
};
const conversations = [
  {
    channel: 'wechat', chatType: 'group', chatId: 'wechat:group:fresh@chatroom',
    senderId: 'wechat:member-a', role: 'user', content: '流程讨论', createdAt: '2026-08-14T00:00:00.000Z',
  },
  {
    channel: 'wechat', chatType: 'group', chatId: 'wechat:group:fresh@chatroom',
    senderId: 'wechat:member-b', role: 'user', content: '组织讨论', createdAt: '2026-08-14T00:00:01.000Z',
  },
  {
    channel: 'wechat', chatType: 'group', chatId: 'wechat:group:cached@chatroom',
    senderId: 'wechat:member-c', role: 'user', content: '缓存讨论', createdAt: '2026-08-14T00:00:02.000Z',
  },
  {
    channel: 'wechat', chatType: 'group', chatId: 'wechat:group:failed@chatroom',
    senderId: 'wechat:member-d', role: 'user', content: '降级讨论', createdAt: '2026-08-14T00:00:03.000Z',
  },
  {
    channel: 'enterpriseChat', chatType: 'group', chatId: 'enterpriseChat:group:unchanged',
    senderId: 'enterpriseChat:member', role: 'user', content: '企业会话讨论', createdAt: '2026-08-14T00:00:04.000Z',
  },
];
const nowMs = Date.parse('2026-08-14T01:00:00.000Z');
const cacheKey = 'wechat-learning-group:cached@chatroom';
values.set(cacheKey, {
  groupName: '缓存微信群',
  fetchedAtMs: nowMs - 1_000,
});
const lookedUp = [];
const enriched = await enrichWeChatLearningContext(conversations, {
  state,
  nowMs,
  lookupGroup: async chatroomId => {
    lookedUp.push(chatroomId);
    if (chatroomId === 'failed@chatroom') throw new Error('temporary group lookup failure');
    return { chatroomId, nickName: 'AI流程与组织变革交流群' };
  },
});

assert.deepEqual(lookedUp.sort(), ['failed@chatroom', 'fresh@chatroom']);
assert.equal(
  enriched.filter(item => item.chatId === 'wechat:group:fresh@chatroom')
    .every(item => item.groupName === 'AI流程与组织变革交流群'),
  true,
);
assert.equal(
  enriched.find(item => item.chatId === 'wechat:group:cached@chatroom').groupName,
  '缓存微信群',
);
assert.equal(
  enriched.find(item => item.chatId === 'wechat:group:failed@chatroom').groupName,
  undefined,
  'one failed group lookup must degrade without blocking learning',
);
assert.equal(
  enriched.find(item => item.channel === 'enterpriseChat').groupName,
  undefined,
  'non-WeChat evidence must remain unchanged',
);
assert.equal(audits.some(item => item.event === 'wechat_learning_group_lookup_failed'), true);
assert.equal(JSON.stringify(audits).includes('failed@chatroom'), false, 'audit must not expose raw chat IDs');
assert.equal(
  values.has('wechat-learning-group:fresh@chatroom'),
  true,
  'successful lookups must be cached locally',
);

console.log('WECHAT_LEARNING_CONTEXT_TEST_OK');
