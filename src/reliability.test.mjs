import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as reliability from './reliability.mjs';
import {
  assertCompleteSearchResult,
  boundedInteger,
  canPerformMutation,
  effectiveTask,
  evaluateEventStatus,
  evaluateHealth,
  isBareMention,
  interactiveInboundRateLimitPolicy,
  finalInboundFailurePolicy,
  planPollWindow,
  shouldObserveWithoutReply,
  validateInboundPayload,
} from './reliability.mjs';

assert.deepEqual(interactiveInboundRateLimitPolicy({ semanticCandidate: true }), {
  apply: false,
  notify: false,
});
assert.deepEqual(interactiveInboundRateLimitPolicy({ contextOnly: true }), {
  apply: false,
  notify: false,
});
assert.deepEqual(interactiveInboundRateLimitPolicy({}), {
  apply: true,
  notify: true,
});
assert.equal(shouldObserveWithoutReply({ contextOnly: true }), true);
assert.equal(shouldObserveWithoutReply({}), false);
assert.deepEqual(finalInboundFailurePolicy(), {
  disposition: 'dead_letter',
  notifyUser: false,
});

{
  assert.equal(typeof reliability.initializeOptionalPoller, 'function');
  const unavailable = new Error('enterprise permission is unavailable');
  assert.deepEqual(
    await reliability.initializeOptionalPoller(async () => { throw unavailable; }),
    { active: false, error: unavailable },
  );
  assert.deepEqual(
    await reliability.initializeOptionalPoller(async () => true),
    { active: true, error: null },
  );
}

{
  assert.deepEqual(validateInboundPayload({
    message: { message_id: 'om_1', chat_id: 'oc_1', chat_type: 'group' },
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_1' } },
  }), { ok: true });
  assert.equal(validateInboundPayload({
    message: { message_id: 'om_1' },
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_1' } },
  }).ok, false);
}

{
  assert.match(effectiveTask('', { messageType: 'text' }), /只 @ 了你/);
  assert.equal(effectiveTask('正常问题', { messageType: 'text' }), '正常问题');
  assert.equal(isBareMention('', 'text'), true);
  assert.equal(isBareMention('', 'post'), true);
  assert.equal(isBareMention('有问题', 'text'), false);
  assert.equal(isBareMention('', 'file'), false);
}

{
  assert.equal(
    typeof reliability.resolveBareMentionTask,
    'function',
    'bare mention must be able to recover the latest unanswered context',
  );
  if (typeof reliability.resolveBareMentionTask === 'function') {
    const question = '如何解决智能体幻觉和多个智能体语义不一致？';
    const recovered = reliability.resolveBareMentionTask('', {
      messageType: 'text',
      currentSenderId: 'wechat:zigaoliu',
      nowMs: Date.parse('2026-08-24T23:10:12.000Z'),
      history: [
        {
          role: 'user',
          senderId: 'wechat:zigaoliu',
          content: question,
          sourceMessageId: 'previous-question',
          createdAt: '2026-08-24T23:10:04.000Z',
        },
      ],
    });
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.sourceMessageId, 'previous-question');
    assert.match(recovered.task, new RegExp(question.replace(/[?？]/g, '[?？]')));
    assert.doesNotMatch(recovered.task, /想让我帮你看什么/);

    const interrupted = reliability.resolveBareMentionTask('', {
      messageType: 'text',
      currentSenderId: 'member-a',
      nowMs: Date.parse('2026-08-24T23:10:12.000Z'),
      history: [
        { role: 'user', senderId: 'member-a', content: '请评价这个架构', createdAt: '2026-08-24T23:10:04.000Z' },
        { role: 'user', senderId: 'member-b', content: '我们先讨论另一个问题', createdAt: '2026-08-24T23:10:08.000Z' },
      ],
    });
    assert.equal(interrupted.recovered, false, 'another member must make group context ambiguous');
    assert.match(interrupted.task, /结合最近会话记录/);
    assert.doesNotMatch(interrupted.task, /想让我帮你看什么/);

    const answered = reliability.resolveBareMentionTask('', {
      messageType: 'text',
      currentSenderId: 'member-a',
      nowMs: Date.parse('2026-08-24T23:10:12.000Z'),
      history: [
        { role: 'user', senderId: 'member-a', content: '请评价这个架构', createdAt: '2026-08-24T23:10:04.000Z' },
        { role: 'assistant', senderId: 'member-a', content: '结论：这个架构缺少运行时验证。', createdAt: '2026-08-24T23:10:08.000Z' },
      ],
    });
    assert.equal(answered.recovered, false, 'a substantively answered question must not be replayed');

    const stale = reliability.resolveBareMentionTask('', {
      messageType: 'text',
      currentSenderId: 'member-a',
      nowMs: Date.parse('2026-08-24T23:30:12.000Z'),
      history: [
        { role: 'user', senderId: 'member-a', content: '二十分钟前的问题', createdAt: '2026-08-24T23:10:04.000Z' },
      ],
    });
    assert.equal(stale.recovered, false, 'stale context must not be guessed as the current target');
  }
}

{
  const root = fileURLToPath(new URL('..', import.meta.url));
  const indexSource = await readFile(`${root}/src/index.mjs`, 'utf8');
  assert.match(indexSource, /resolveBareMentionTask/);
  assert.match(indexSource, /bareMentionResolution\.task/);
  assert.doesNotMatch(indexSource, /const answer = '我在，想让我帮你看什么？'/);
}

{
  const result = { data: { has_more: false, messages: [{ message_id: 'om_1' }] } };
  assert.equal(assertCompleteSearchResult(result, 'group').length, 1);
  assert.throws(
    () => assertCompleteSearchResult({ data: { has_more: true, messages: [] } }, 'group'),
    /group.*未完整返回/,
  );
}

{
  assert.equal(boundedInteger(undefined, { name: 'poll', fallback: 5000, min: 1000, max: 60000 }), 5000);
  assert.equal(boundedInteger(2500, { name: 'poll', fallback: 5000, min: 1000, max: 60000 }), 2500);
  assert.throws(
    () => boundedInteger('abc', { name: 'poll', fallback: 5000, min: 1000, max: 60000 }),
    /poll/,
  );
  assert.throws(
    () => boundedInteger(100, { name: 'poll', fallback: 5000, min: 1000, max: 60000 }),
    /poll/,
  );
}

{
  assert.equal(canPerformMutation('ou_owner', 'ou_owner'), true);
  assert.equal(canPerformMutation('ou_other', 'ou_owner'), false);
}

{
  assert.deepEqual(evaluateHealth({
    nowMs: 100_000,
    cursorMs: 95_000,
    maxPollAgeMs: 30_000,
    processingCount: 0,
    failedCount: 0,
  }), { healthy: true, issues: [] });
  const unhealthy = evaluateHealth({
    nowMs: 100_000,
    cursorMs: 1_000,
    maxPollAgeMs: 30_000,
    processingCount: 2,
    failedCount: 1,
  });
  assert.equal(unhealthy.healthy, false);
  assert.equal(unhealthy.issues.length, 3);
  assert.equal(evaluateHealth({
    nowMs: 100_000,
    cursorMs: 95_000,
    maxPollAgeMs: 30_000,
    processingCount: 0,
    failedCount: 0,
    proxyReachable: false,
  }).issues.includes('codex_proxy_unreachable'), true);
}

{
  assert.deepEqual(evaluateEventStatus({
    apps: [{ app_id: 'cli_1', running: true, active_consumers: 1 }],
  }, 'cli_1'), { healthy: true, issues: [] });
  assert.equal(evaluateEventStatus({
    apps: [{ app_id: 'cli_1', running: true, active_consumers: 0 }],
  }, 'cli_1').healthy, false);
}

{
  assert.deepEqual(planPollWindow(900_000, 1_000_000, {
    overlapMs: 10_000,
    maxCatchupMs: 500_000,
    maxWindowMs: 300_000,
  }), { startMs: 890_000, endMs: 1_000_000 });
  assert.deepEqual(planPollWindow(100_000, 1_000_000, {
    overlapMs: 10_000,
    maxCatchupMs: 500_000,
    maxWindowMs: 300_000,
  }), { startMs: 490_000, endMs: 790_000 });
}

console.log('RELIABILITY_TEST_OK');
