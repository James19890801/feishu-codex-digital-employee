import assert from 'node:assert/strict';
import {
  parseGeneratedMomentsPost,
  planMomentsDay,
} from './wechat-moments-publisher.mjs';

const MIDDAY = Date.parse('2026-08-16T12:05:00+08:00');
const NEXT_DAY = Date.parse('2026-08-17T00:01:00+08:00');

{
  const plan = planMomentsDay({
    nowMs: MIDDAY,
    activatedAtMs: 0,
    random: () => 0.5,
  });
  assert.equal(plan.day, '2026-08-16');
  assert.equal(plan.slots.length, 2);
  assert.equal(plan.slots[0].id, 'activation');
  assert.equal(plan.slots[0].atMs, MIDDAY);
  assert.equal(plan.slots[1].id, 'evening');
  assert.equal(new Date(plan.slots[1].atMs).toISOString(), '2026-08-16T11:45:00.000Z');
}

{
  const plan = planMomentsDay({
    nowMs: NEXT_DAY,
    activatedAtMs: MIDDAY,
    random: () => 0.5,
  });
  assert.deepEqual(plan.slots.map(slot => slot.id), ['morning', 'evening']);
  assert.equal(new Date(plan.slots[0].atMs).toISOString(), '2026-08-17T03:00:00.000Z');
  assert.equal(new Date(plan.slots[1].atMs).toISOString(), '2026-08-17T11:45:00.000Z');
  assert.ok(plan.slots.every(slot => slot.status === 'pending'));
}

const knowledge = `内部知识参考（只用于增强回答）：
流程的核心不是画图，而是让跨部门结果拥有稳定的责任、输入、输出和例外处理机制。AI 可以缩短判断和执行之间的距离，但不应模糊最终责任。`;
const validContent = '企业引入 AI，最容易的是把对话框塞进每个环节，最难的是重新分配判断权和责任。如果流程本来就没有明确输出和例外机制，AI 只会让混乱跑得更快。它像给购物车装上火箭：速度很感人，方向不对时也更感人。所以先问谁对结果负责，再问 AI 能代劳什么。';

{
  const parsed = parseGeneratedMomentsPost(JSON.stringify({
    topic: 'AI 与流程责任',
    content: validContent,
  }), { knowledge, history: [] });
  assert.deepEqual(parsed, {
    topic: 'AI 与流程责任',
    content: validContent,
  });
}

assert.equal(parseGeneratedMomentsPost('not-json', { knowledge, history: [] }), null);
assert.equal(parseGeneratedMomentsPost(JSON.stringify({
  topic: 'AI',
  content: '太短了',
}), { knowledge, history: [] }), null);
assert.equal(parseGeneratedMomentsPost(JSON.stringify({
  topic: 'AI',
  content: `${validContent} 资料路径是 /Users/Administrator/Desktop/private.pdf`,
}), { knowledge, history: [] }), null);

{
  const copied = '流程的核心不是画图，而是让跨部门结果拥有稳定的责任、输入、输出和例外处理机制。AI 可以缩短判断和执行之间的距离，但不应模糊最终责任。这段内容基本原样复制，只是在末尾多加了一句话。';
  assert.equal(parseGeneratedMomentsPost(JSON.stringify({ topic: '照抄', content: copied }), {
    knowledge,
    history: [],
  }), null);
}

assert.equal(parseGeneratedMomentsPost(JSON.stringify({
  topic: 'AI 与流程责任',
  content: validContent.replace('购物车', '手推车'),
}), { knowledge, history: [validContent] }), null);

console.log('WECHAT_MOMENTS_PUBLISHER_TEST_OK');
