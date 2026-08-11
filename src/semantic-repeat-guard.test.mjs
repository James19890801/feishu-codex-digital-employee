import assert from 'node:assert/strict';
import {
  compareSemanticTopics,
  normalizeSemanticText,
  semanticTopic,
} from './semantic-repeat-guard.mjs';

assert.equal(
  normalizeSemanticText('<@bot> 收到，这个需要本人确认/安排，我帮您转达一下。 @詹老师'),
  '这个需要本人确认安排我帮您转达一下',
);

assert.equal(compareSemanticTopics(
  semanticTopic('@詹老师 好，等本人确认后直接发我。'),
  semanticTopic('<@owner> 好，等本人确认后直接发我！'),
).repeat, true);

assert.equal(compareSemanticTopics(
  semanticTopic('这个需要本人确认安排，确认后再往下推进。'),
  semanticTopic('等本人确认后再推进，确认了发我一声。'),
).repeat, true);

assert.equal(compareSemanticTopics(
  semanticTopic('行，确认了第一时间跟您说。 @詹老师'),
  semanticTopic('收到，这个需要本人确认/安排，我帮您转达一下。 @詹老师'),
).repeat, true);

for (const [left, right, label] of [
  ['MYS-11 等确认后推进', 'MYS-12 等确认后推进', 'Issue'],
  ['会议改到8月9日推进', '会议改到8月10日推进', 'date'],
  ['查看 https://example.com/a 后推进', '查看 https://example.com/b 后推进', 'URL'],
  ['项目完成 80%', '项目完成 90%', 'number'],
]) {
  assert.equal(
    compareSemanticTopics(semanticTopic(left), semanticTopic(right)).repeat,
    false,
    `changed ${label} must reset the topic`,
  );
}

assert.equal(compareSemanticTopics(
  semanticTopic('等确认后推进'),
  semanticTopic('继续展开说一下等确认后怎么推进'),
).repeat, false);

assert.equal(compareSemanticTopics(semanticTopic('好的'), semanticTopic('收到')).repeat, false);
assert.equal(compareSemanticTopics(semanticTopic('好的'), semanticTopic('好的！')).repeat, true);

console.log('SEMANTIC_REPEAT_GUARD_TEST_OK');
