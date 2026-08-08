import assert from 'node:assert/strict';
import {
  assessGroupEngagement,
  buildSemanticEngagementPrompt,
  parseSemanticEngagementDecision,
} from './semantic-group-engagement.mjs';

const base = {
  enabled: true,
  chatType: 'group',
  messageType: 'text',
  currentSenderId: 'member-a',
  aliases: ['AIPRO', '詹老师助理', '数字人'],
  recentMessages: [],
  nowMs: Date.parse('2026-08-08T12:10:00.000Z'),
};

assert.equal(assessGroupEngagement({
  ...base,
  explicitMention: true,
  text: '帮我看一下这个方案',
}).action, 'reply_explicit');

assert.equal(assessGroupEngagement({
  ...base,
  text: '詹老师助理，这个结论依据是什么？',
}).action, 'reply_named');

assert.equal(assessGroupEngagement({
  ...base,
  text: '你刚才第二点的依据是什么？',
  recentMessages: [{
    role: 'assistant', senderId: 'member-a', content: '第二点是流程责任变化。',
    createdAt: '2026-08-08T12:05:00.000Z',
  }],
}).action, 'reply_continuation');

assert.equal(assessGroupEngagement({
  ...base,
  text: '好的',
  recentMessages: [{
    role: 'assistant', senderId: 'member-a', content: '可以这样推进。',
    createdAt: '2026-08-08T12:05:00.000Z',
  }],
}).action, 'observe');

assert.equal(assessGroupEngagement({
  ...base,
  text: 'AI 对流程管理的影响应该怎么评估？',
}).action, 'classify');

assert.equal(assessGroupEngagement({
  ...base,
  enabled: false,
  text: '詹老师助理帮我看一下',
}).action, 'observe');

assert.equal(assessGroupEngagement({
  ...base,
  humanTakeover: true,
  text: '詹老师助理帮我看一下',
}).action, 'suppress');

assert.deepEqual(parseSemanticEngagementDecision(
  '{"action":"reply","confidence":0.91,"reasonCode":"active_topic","targetSenderIds":["member-a"]}',
  { threshold: 0.86, defaultSenderId: 'member-a' },
), {
  action: 'reply_semantic', confidence: 0.91, reasonCode: 'active_topic',
  targetSenderIds: ['member-a'],
});

assert.equal(parseSemanticEngagementDecision(
  '{"action":"reply","confidence":0.72,"reasonCode":"weak"}',
  { threshold: 0.86, defaultSenderId: 'member-a' },
).action, 'observe');
assert.equal(parseSemanticEngagementDecision('not json').action, 'observe');
assert.equal(parseSemanticEngagementDecision('[{"action":"reply"}]').action, 'observe');

const messages = Array.from({ length: 35 }, (_, index) => ({
  role: 'user', senderId: `member-${index}`, content: `第${index + 1}条`,
}));
const prompt = buildSemanticEngagementPrompt({
  text: '这个问题数字人需要参与吗？',
  senderId: 'member-a',
  recentMessages: messages,
});
assert.equal(prompt.includes('第5条'), false);
assert.equal(prompt.includes('第6条'), true);
assert.equal(prompt.includes('第35条'), true);
assert.equal(prompt.includes('只输出一个 JSON 对象'), true);

console.log('SEMANTIC_GROUP_ENGAGEMENT_TEST_OK');
