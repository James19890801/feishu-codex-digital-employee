import assert from 'node:assert/strict';
import {
  buildFirstTakeoverGreeting,
  enforceReplyLength,
  replyLengthPolicy,
  shouldIntroduceAssistant,
} from './conversation-etiquette.mjs';

assert.deepEqual(replyLengthPolicy('你好'), { detailed: false, maxChars: 48 });
assert.deepEqual(replyLengthPolicy('这件事你怎么看？'), { detailed: false, maxChars: 90 });
assert.deepEqual(replyLengthPolicy('请给我一份完整的实施方案'), { detailed: true, maxChars: 3800 });

assert.equal(enforceReplyLength('你好，很高兴认识你。你现在想聊什么？', '你好').length <= 48, true);
assert.equal(enforceReplyLength('第一段。'.repeat(80), '请给我一份详细方案'), '第一段。'.repeat(80));
assert.equal(
  enforceReplyLength('这是一段很长的日常回复，没有必要全部发给对方。'.repeat(20), '你觉得呢').length <= 90,
  true,
);

const greeting = buildFirstTakeoverGreeting({ ownerLabel: '新用户' });
assert.match(greeting, /我是新用户的数字人/);
assert.match(greeting, /新用户现在不在/);
assert.match(greeting, /要继续聊吗/);
assert.doesNotMatch(greeting, /阿充|詹老师|AI 助理 James/);
assert.doesNotMatch(greeting, /告诉我他的一切|我掌握他所有|他懂的我也懂/);

assert.equal(shouldIntroduceAssistant({ chatType: 'p2p', isOwner: false, history: [] }), true);
assert.equal(shouldIntroduceAssistant({
  chatType: 'p2p', isOwner: false, history: [{ role: 'assistant', content: greeting }],
}), false);
assert.equal(shouldIntroduceAssistant({ chatType: 'group', isOwner: false, history: [] }), false);
assert.equal(shouldIntroduceAssistant({ chatType: 'p2p', isOwner: true, history: [] }), false);

console.log('CONVERSATION_ETIQUETTE_TEST_OK');
