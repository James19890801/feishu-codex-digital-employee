import assert from 'node:assert/strict';
import * as reliability from './reliability.mjs';
import {
  assertCompleteSearchResult,
  boundedInteger,
  canPerformMutation,
  effectiveTask,
  evaluateEventStatus,
  evaluateHealth,
  isBareMention,
  planPollWindow,
  validateInboundPayload,
} from './reliability.mjs';

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

{
  assert.equal(typeof reliability.shouldRecycleAiRuntime, 'function');
  assert.equal(reliability.shouldRecycleAiRuntime(
    new Error('Codex CLI failed: Operation not permitted (os error 1)'),
  ), true);
  assert.equal(reliability.shouldRecycleAiRuntime(
    new Error('Codex CLI failed: process timed out after 120000ms'),
  ), false);
  assert.equal(reliability.shouldRecycleAiRuntime(
    new Error('DWS failed: Operation not permitted (os error 1)'),
  ), false);
}

{
  let dueRuns = 0;
  const scheduler = new reliability.EarliestDueScheduler({
    onDue: async () => { dueRuns += 1; },
  });
  scheduler.schedule(new Date(Date.now() + 250).toISOString());
  await new Promise(resolve => setTimeout(resolve, 10));
  scheduler.schedule(new Date(Date.now() + 30).toISOString());
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(dueRuns, 1, 'an earlier retry must wake without another inbound event');
  await new Promise(resolve => setTimeout(resolve, 220));
  assert.equal(dueRuns, 1, 'rescheduling must cancel the superseded timer');
  scheduler.stop();
}

{
  let dueRuns = 0;
  const scheduler = new reliability.EarliestDueScheduler({
    onDue: async () => { dueRuns += 1; },
  });
  scheduler.schedule(new Date(Date.now() + 30).toISOString());
  scheduler.stop();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(dueRuns, 0, 'shutdown must cancel a pending retry wake-up');
}

{
  let drainRuns = 0;
  const retryAt = new Date(Date.now() + 30).toISOString();
  const controller = new reliability.InboundDrainController({
    drain: async () => { drainRuns += 1; },
    nextAvailableAt: () => (drainRuns === 1 ? retryAt : null),
  });
  await controller.trigger();
  assert.equal(drainRuns, 1);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(drainRuns, 2, 'a due retry must drain without a new inbound event');
  controller.stop();
}

console.log('RELIABILITY_TEST_OK');
