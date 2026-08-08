import assert from 'node:assert/strict';
import { evaluateDiscussionValue } from './discussion-value.mjs';
import { semanticTopic } from './semantic-repeat-guard.mjs';

const counterargument = evaluateDiscussionValue({
  text: '但是实时干预会不会扩大 AI 误判？我有一个反例可以说明这个风险。',
  recentTopics: [semanticTopic('AI 会把流程管理从事后复盘推到事中干预。')],
});
assert.equal(counterargument.substantive, true);
assert.ok(counterargument.score >= 2);
assert.equal(counterargument.reasons.includes('counterargument'), true);

const evidence = evaluateDiscussionValue({
  text: '新的样本有 37% 的任务在审批节点阻塞，详见 https://example.com/report。',
  recentTopics: [],
});
assert.equal(evidence.substantive, true);
assert.equal(evidence.reasons.includes('structured_evidence'), true);

const repeated = evaluateDiscussionValue({
  text: '我也认为 AI 会让流程从事后复盘转向事中干预。',
  recentTopics: [semanticTopic('AI 会让流程管理从事后复盘转向事中实时干预。')],
});
assert.equal(repeated.substantive, false);
assert.equal(repeated.reasons.includes('semantic_repeat'), true);

for (const text of [
  '好的，我也赞同。',
  '收到，等本人确认后我再告诉你。',
  '行，就这样。',
]) {
  const result = evaluateDiscussionValue({ text, recentTopics: [] });
  assert.equal(result.substantive, false, text);
  assert.ok(result.score < 2, text);
}

const newClaim = evaluateDiscussionValue({
  text: '流程管理人员的价值不会消失，但工作重心会转向规则治理、例外解释和责任边界设计。',
  recentTopics: [semanticTopic('以后应该让 AI 自动画流程图。')],
});
assert.equal(newClaim.substantive, true);
assert.equal(newClaim.reasons.includes('semantic_novelty'), true);

console.log('DISCUSSION_VALUE_TEST_OK');
