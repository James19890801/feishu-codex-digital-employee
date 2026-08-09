import assert from 'node:assert/strict';
import {
  assessGroupHostCandidate,
  buildGroupHostDecisionPrompt,
  buildGroupHostReplyPrompt,
  normalizeGroupHostReply,
  parseGroupHostDecision,
  processGroupHostCandidate,
  relatedHumanReply,
} from './group-host-mode.mjs';

const base = {
  enabled: true,
  allowlisted: true,
  chatType: 'group',
  messageType: 'text',
};

assert.equal(assessGroupHostCandidate({
  ...base,
  text: '大家怎么看 AI Agent 对项目协作的影响？',
}).eligible, true);

assert.equal(assessGroupHostCandidate({
  ...base,
  text: '我觉得数字人会把项目协作从信息同步推向主动协调，这个变化值得讨论。',
}).eligible, true);

for (const input of [
  { text: '收到' },
  { text: '大家好' },
  { text: '会议改到下午三点。' },
  { text: '这个方案怎么样？', allowlisted: false },
  { text: '这个方案怎么样？', chatType: 'p2p' },
  { text: '这个方案怎么样？', mentionedOther: true },
  { text: 'AIPRO，这个方案怎么样？', addressedAssistant: true },
  { text: '你刚才的判断依据是什么？', continuation: true },
]) {
  assert.equal(assessGroupHostCandidate({ ...base, ...input }).eligible, false, input.text);
}

const candidate = {
  messageId: 'message-1',
  chatId: 'dingtalk:group:test',
  senderId: 'dingtalk:member-a',
  text: '大家怎么看 AI Agent 对项目协作的影响？',
  createdAtMs: 1_000,
};
const laterMessages = [{
  role: 'user', senderId: 'dingtalk:member-b',
  content: '我认为最大的变化是协调成本下降。',
  sourceMessageId: 'message-2', createdAt: new Date(2_000).toISOString(),
}];
const decisionPrompt = buildGroupHostDecisionPrompt({ candidate, laterMessages });
assert.match(decisionPrompt, /只输出一个 JSON 对象/);
assert.match(decisionPrompt, /human_picked_up/);
assert.match(decisionPrompt, /最大的变化是协调成本下降/);

assert.deepEqual(parseGroupHostDecision(
  '{"action":"host","confidence":0.91,"reasonCode":"silent_public_topic"}',
), { shouldHost: true, confidence: 0.91, reasonCode: 'silent_public_topic' });
assert.equal(parseGroupHostDecision(
  '{"action":"host","confidence":0.7,"reasonCode":"weak"}',
).shouldHost, false);
assert.equal(parseGroupHostDecision('not json').shouldHost, false);
assert.equal(parseGroupHostDecision('[{"action":"host"}]').shouldHost, false);

assert.equal(relatedHumanReply(candidate, laterMessages), true);
assert.equal(relatedHumanReply(candidate, [{
  ...laterMessages[0],
  senderId: candidate.senderId,
}]), false);
assert.equal(relatedHumanReply(candidate, [{
  ...laterMessages[0],
  content: '明天下午三点开会。',
}]), false);

const replyPrompt = buildGroupHostReplyPrompt({
  candidate,
  recentMessages: laterMessages,
});
assert.match(replyPrompt, /简短承接/);
assert.match(replyPrompt, /一个增量观察/);
assert.match(replyPrompt, /一个开放问题/);
assert.match(replyPrompt, /不得声称群内已经形成共识/);

const validReply = '这个话题值得接住。一个关键变化是数字人不再只负责回答，而会开始识别协作中的等待和断点，这可能重新定义项目协调者的工作重心。大家更担心它判断错了，还是担心团队逐渐失去主动协调能力？';
assert.equal(normalizeGroupHostReply(validReply), validReply);
assert.equal(normalizeGroupHostReply('大家怎么看？'), '');
assert.equal(normalizeGroupHostReply('这个话题很重要，我们可以继续讨论，但这里没有提出任何开放问题。'), '');
assert.equal(normalizeGroupHostReply(`${validReply} 还有第二个问题吗？`), '');

let classifierCalls = 0;
let generatorCalls = 0;
let sendCalls = 0;
const processorDeps = {
  runDecisionClassifier: async () => {
    classifierCalls += 1;
    return '{"action":"host","confidence":0.94,"reasonCode":"silent_public_topic"}';
  },
  runReplyGenerator: async () => {
    generatorCalls += 1;
    return validReply;
  },
  send: async reply => {
    sendCalls += 1;
    assert.equal(reply, validReply);
  },
};

assert.deepEqual(await processGroupHostCandidate({
  candidate,
  recentMessages: laterMessages,
  ...processorDeps,
}), { action: 'human_picked_up', reasonCode: 'related_human_reply' });
assert.equal(classifierCalls, 0);
assert.equal(sendCalls, 0);

assert.deepEqual(await processGroupHostCandidate({
  candidate,
  recentMessages: [{ ...laterMessages[0], senderId: candidate.senderId }],
  ...processorDeps,
}), { action: 'replied', reasonCode: 'silent_public_topic', reply: validReply });
assert.equal(classifierCalls, 1, '原发送者补充不应取消主持候选');
assert.equal(generatorCalls, 1);
assert.equal(sendCalls, 1);

assert.deepEqual(await processGroupHostCandidate({
  candidate,
  recentMessages: [],
  takeoverActive: true,
  ...processorDeps,
}), { action: 'suppressed', reasonCode: 'human_takeover' });
assert.deepEqual(await processGroupHostCandidate({
  candidate,
  recentMessages: [],
  cooldownActive: true,
  ...processorDeps,
}), { action: 'suppressed', reasonCode: 'reply_cooldown' });
assert.equal(classifierCalls, 1);

assert.deepEqual(await processGroupHostCandidate({
  candidate,
  recentMessages: [],
  runDecisionClassifier: async () => 'not json',
  runReplyGenerator: async () => { throw new Error('must not generate'); },
  send: async () => { throw new Error('must not send'); },
}), { action: 'observe', reasonCode: 'invalid_classifier_output' });

assert.deepEqual(await processGroupHostCandidate({
  candidate,
  recentMessages: [],
  runDecisionClassifier: processorDeps.runDecisionClassifier,
  runReplyGenerator: async () => '太短了，大家怎么看？',
  send: async () => { throw new Error('must not send'); },
}), { action: 'observe', reasonCode: 'invalid_reply' });

await assert.rejects(
  processGroupHostCandidate({
    candidate,
    recentMessages: [],
    runDecisionClassifier: processorDeps.runDecisionClassifier,
    runReplyGenerator: processorDeps.runReplyGenerator,
    send: async () => { throw new Error('send failed'); },
  }),
  /send failed/,
);

console.log('GROUP_HOST_MODE_TEST_OK');
