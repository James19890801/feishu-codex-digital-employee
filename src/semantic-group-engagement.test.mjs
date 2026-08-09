import assert from 'node:assert/strict';
import {
  assessGroupEngagement,
  buildSemanticEngagementPrompt,
  decideSemanticGroupEngagement,
  isSemanticEntryCooldownActive,
  parseSemanticEngagementDecision,
} from './semantic-group-engagement.mjs';

assert.equal(isSemanticEntryCooldownActive({
  lastReplyAtMs: 1_000,
  nowMs: 61_000,
  cooldownMs: 120_000,
}), true);
assert.equal(isSemanticEntryCooldownActive({
  lastReplyAtMs: 1_000,
  nowMs: 121_001,
  cooldownMs: 120_000,
}), false);
assert.equal(isSemanticEntryCooldownActive({
  lastReplyAtMs: 1_000,
  nowMs: 61_000,
  cooldownMs: 120_000,
  activeDiscussion: true,
}), false);

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
  text: '我们正在讨论数字人对组织和流程的影响。',
}).action, 'observe');

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

assert.equal(assessGroupEngagement({
  ...base,
  mentionedOther: true,
  text: '@另一位同事 这个结论依据是什么？',
}).action, 'observe');

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

{
  let classifierCalls = 0;
  const decision = await decideSemanticGroupEngagement({
    assessment: { ...base, text: '詹老师助理，帮我看看' },
    runClassifier: async () => { classifierCalls += 1; return '{}'; },
  });
  assert.equal(decision.shouldReply, true);
  assert.equal(decision.action, 'reply_named');
  assert.equal(classifierCalls, 0);
}

{
  let receivedPrompt = '';
  const decision = await decideSemanticGroupEngagement({
    assessment: { ...base, text: 'AI 对流程管理的影响应该怎么评估？' },
    recentMessages: messages,
    threshold: 0.86,
    runClassifier: async classifierPrompt => {
      receivedPrompt = classifierPrompt;
      return '{"action":"reply","confidence":0.92,"reasonCode":"relevant_expertise","targetSenderIds":["member-a"]}';
    },
  });
  assert.equal(decision.shouldReply, true);
  assert.equal(decision.action, 'reply_semantic');
  assert.equal(receivedPrompt.includes('第5条'), false);
  assert.equal(receivedPrompt.includes('第6条'), true);
}

{
  let classifierCalls = 0;
  const decision = await decideSemanticGroupEngagement({
    assessment: { ...base, text: '大家怎么看 AI 对项目协作的影响？' },
    deferHost: true,
    runClassifier: async () => { classifierCalls += 1; return '{}'; },
  });
  assert.deepEqual(decision, {
    shouldReply: false,
    action: 'defer_host',
    reasonCode: 'group_host_silence_window',
    confidence: 1,
    targetSenderIds: [],
  });
  assert.equal(classifierCalls, 0, '主持模式应先进入静默窗口，不能立刻调用介入分类器');
}

for (const assessment of [{
  ...base,
  text: '詹老师助理，这个问题你怎么看？',
}, {
  ...base,
  text: '你刚才第二点的依据是什么？',
  recentMessages: [{
    role: 'assistant', senderId: 'member-a', content: '第二点是流程责任变化。',
    createdAt: '2026-08-08T12:05:00.000Z',
  }],
}]) {
  const decision = await decideSemanticGroupEngagement({
    assessment,
    deferHost: true,
  });
  assert.equal(decision.shouldReply, true, '直接点名或上下文续问仍应立即回复');
}

assert.equal((await decideSemanticGroupEngagement({
  assessment: {
    ...base,
    text: '@另一位同事 这个问题大家怎么看？',
    mentionedOther: true,
  },
  deferHost: true,
})).action, 'observe');

{
  const decision = await decideSemanticGroupEngagement({
    assessment: { ...base, text: 'AI 对流程管理的影响应该怎么评估？' },
    recentMessages: messages,
    runClassifier: async () => { throw new Error('runtime unavailable'); },
  });
  assert.deepEqual(decision, {
    shouldReply: false,
    action: 'observe',
    reasonCode: 'classifier_error',
    confidence: 0,
    targetSenderIds: [],
  });
}

console.log('SEMANTIC_GROUP_ENGAGEMENT_TEST_OK');
