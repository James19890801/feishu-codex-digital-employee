import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentState } from './state.mjs';
import {
  parseGeneratedMomentsPost,
  planMomentsDay,
  WeChatMomentsPublisher,
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
  topic: 'AI 与流程责任',
  content: validContent,
}), { knowledge: '', history: [] }), null);
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

const secondContent = '流程指标最怕一件事：大家都完成了自己的 KPI，客户却还在等结果。AI 可以帮我们更快地算出每个节点的效率，但管理者更该问：整条链路是否真的变快了？只盯局部指标，就像每位厨师都宣布出菜成功，最后桌上只有七只盘子和一位饥饿的客人。';

function temporaryState(prefix) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const state = new AgentState(join(directory, 'state.sqlite'));
  return {
    state,
    close() {
      state.db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

{
  const database = temporaryState('aipro-moments-publisher-');
  try {
    let nowMs = MIDDAY;
    let publishCalls = 0;
    let generateCalls = 0;
    let cleared = false;
    const workerOptions = {
      state: database.state,
      channel: {
        publishTextMoment: async () => {
          publishCalls += 1;
          return { data: { id: String(9000 + publishCalls) } };
        },
      },
      retrieveKnowledge: async () => knowledge,
      generate: async () => JSON.stringify({
        topic: generateCalls++ === 0 ? 'AI 与流程责任' : '端到端流程指标',
        content: generateCalls === 1 ? validContent : secondContent,
      }),
      now: () => nowMs,
      random: () => 0.5,
      setIntervalImpl: callback => ({ callback }),
      clearIntervalImpl: () => { cleared = true; },
    };
    const publisher = new WeChatMomentsPublisher(workerOptions);
    await publisher.start();
    assert.equal(publishCalls, 1, 'first activation must publish immediately');
    let persisted = database.state.get('wechat-moments-publisher', 'worker', {});
    assert.deepEqual(persisted.plan.slots.map(item => item.status), ['sent', 'pending']);
    assert.equal(persisted.history.length, 1);

    await Promise.all([publisher.tick('concurrent-a'), publisher.tick('concurrent-b')]);
    assert.equal(publishCalls, 1, 'concurrent ticks must not duplicate a sent slot');
    publisher.stop();
    assert.equal(cleared, true);

    const restarted = new WeChatMomentsPublisher(workerOptions);
    await restarted.start();
    assert.equal(publishCalls, 1, 'restart must preserve the activation result');
    nowMs = Date.parse('2026-08-16T19:46:00+08:00');
    await restarted.tick('evening');
    assert.equal(publishCalls, 2);
    await restarted.tick('daily-cap');
    assert.equal(publishCalls, 2, 'daily hard cap must be two');
    persisted = database.state.get('wechat-moments-publisher', 'worker', {});
    assert.deepEqual(persisted.plan.slots.map(item => item.status), ['sent', 'sent']);
    assert.equal(persisted.history.length, 2);
    restarted.stop();
  } finally {
    database.close();
  }
}

{
  const database = temporaryState('aipro-moments-publisher-ambiguous-');
  try {
    let publishCalls = 0;
    const options = {
      state: database.state,
      channel: {
        publishTextMoment: async () => {
          publishCalls += 1;
          throw new Error('network timeout after upload');
        },
      },
      retrieveKnowledge: async () => knowledge,
      generate: async () => JSON.stringify({ topic: 'AI 与流程责任', content: validContent }),
      now: () => MIDDAY,
      random: () => 0.5,
      setIntervalImpl: callback => ({ callback }),
      clearIntervalImpl: () => {},
    };
    const first = new WeChatMomentsPublisher(options);
    await first.start();
    first.stop();
    assert.equal(publishCalls, 1);
    let persisted = database.state.get('wechat-moments-publisher', 'worker', {});
    assert.equal(persisted.plan.slots[0].status, 'uncertain');

    const restarted = new WeChatMomentsPublisher(options);
    await restarted.start();
    restarted.stop();
    assert.equal(publishCalls, 1, 'ambiguous external writes must never replay');
    persisted = database.state.get('wechat-moments-publisher', 'worker', {});
    assert.equal(persisted.plan.slots[0].status, 'uncertain');
  } finally {
    database.close();
  }
}

{
  const database = temporaryState('aipro-moments-publisher-retry-');
  try {
    let nowMs = MIDDAY;
    let generateCalls = 0;
    const publisher = new WeChatMomentsPublisher({
      state: database.state,
      channel: { publishTextMoment: async () => { throw new Error('must not publish'); } },
      retrieveKnowledge: async () => knowledge,
      generate: async () => { generateCalls += 1; return 'malformed'; },
      now: () => nowMs,
      random: () => 0.5,
      setIntervalImpl: callback => ({ callback }),
      clearIntervalImpl: () => {},
    });
    await publisher.start();
    assert.equal(generateCalls, 1);
    nowMs += 4 * 60_000;
    await publisher.tick('too-early');
    assert.equal(generateCalls, 1);
    nowMs += 60_000;
    await publisher.tick('retry-two');
    assert.equal(generateCalls, 2);
    nowMs += 5 * 60_000;
    await publisher.tick('retry-three');
    assert.equal(generateCalls, 3);
    const persisted = database.state.get('wechat-moments-publisher', 'worker', {});
    assert.equal(persisted.plan.slots[0].status, 'skipped');
    assert.equal(persisted.plan.slots[0].attempts, 3);
    publisher.stop();
  } finally {
    database.close();
  }
}

{
  const database = temporaryState('aipro-moments-publisher-expired-');
  try {
    let generateCalls = 0;
    database.state.set('wechat-moments-publisher', 'worker', {
      version: 1,
      activatedAtMs: MIDDAY - 24 * 60 * 60_000,
      plan: {
        day: '2026-08-16',
        slots: [
          {
            id: 'morning',
            atMs: Date.parse('2026-08-16T10:30:00+08:00'),
            endMs: Date.parse('2026-08-16T12:00:00+08:00'),
            status: 'pending',
            attempts: 0,
            nextAttemptAtMs: Date.parse('2026-08-16T10:30:00+08:00'),
          },
          {
            id: 'evening',
            atMs: Date.parse('2026-08-16T20:00:00+08:00'),
            endMs: Date.parse('2026-08-16T21:00:00+08:00'),
            status: 'pending',
            attempts: 0,
            nextAttemptAtMs: Date.parse('2026-08-16T20:00:00+08:00'),
          },
        ],
      },
      history: [],
    });
    const publisher = new WeChatMomentsPublisher({
      state: database.state,
      channel: { publishTextMoment: async () => ({}) },
      retrieveKnowledge: async () => knowledge,
      generate: async () => { generateCalls += 1; return '{}'; },
      now: () => MIDDAY,
      setIntervalImpl: callback => ({ callback }),
      clearIntervalImpl: () => {},
    });
    await publisher.start();
    publisher.stop();
    const persisted = database.state.get('wechat-moments-publisher', 'worker', {});
    assert.equal(persisted.plan.slots[0].status, 'skipped');
    assert.equal(persisted.plan.slots[0].reason, 'window_expired');
    assert.equal(persisted.plan.slots[1].status, 'pending');
    assert.equal(generateCalls, 0, 'expired slots must not be backfilled');
  } finally {
    database.close();
  }
}

console.log('WECHAT_MOMENTS_PUBLISHER_TEST_OK');
