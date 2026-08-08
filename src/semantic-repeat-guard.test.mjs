import assert from 'node:assert/strict';
import {
  compareSemanticTopics,
  normalizeSemanticText,
  semanticTopic,
} from './semantic-repeat-guard.mjs';

assert.equal(
  normalizeSemanticText('<@DrBl> 收到，这个需要杨红宝本人确认/安排，我帮您转达一下。 @詹老师'),
  '这个需要杨红宝本人确认安排我帮您转达一下',
);

const exactA = semanticTopic('@詹老师 好，等杨红宝确认后直接发我。');
const exactB = semanticTopic('<@owner> 好，等杨红宝确认后直接发我！');
assert.equal(compareSemanticTopics(exactA, exactB).repeat, true);

const paraphraseA = semanticTopic('这个需要杨红宝本人确认安排，确认后再往下推进。');
const paraphraseB = semanticTopic('等杨红宝本人确认后再推进，确认了发我一声。');
assert.equal(compareSemanticTopics(paraphraseA, paraphraseB).repeat, true);

assert.equal(compareSemanticTopics(
  semanticTopic('MYS-11 等确认后推进'),
  semanticTopic('MYS-12 等确认后推进'),
).repeat, false, 'a changed Issue identifier is new information');

assert.equal(compareSemanticTopics(
  semanticTopic('会议改到8月9日推进'),
  semanticTopic('会议改到8月10日推进'),
).repeat, false, 'a changed date is new information');

assert.equal(compareSemanticTopics(
  semanticTopic('查看 https://example.com/a 后推进'),
  semanticTopic('查看 https://example.com/b 后推进'),
).repeat, false, 'a changed URL is new information');

assert.equal(compareSemanticTopics(
  semanticTopic('等确认后推进'),
  semanticTopic('继续展开说一下等确认后怎么推进'),
).repeat, false, 'an explicit continuation instruction resets the topic');

assert.equal(compareSemanticTopics(
  semanticTopic('好的'),
  semanticTopic('收到'),
).repeat, false, 'different short acknowledgements fail open');

assert.equal(compareSemanticTopics(
  semanticTopic('好的'),
  semanticTopic('好的！'),
).repeat, true, 'an exact normalized short repeat is still a repeat');

console.log('SEMANTIC_REPEAT_GUARD_TEST_OK');
