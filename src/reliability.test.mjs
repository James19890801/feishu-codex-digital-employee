import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentState } from './state.mjs';
import * as reliability from './reliability.mjs';
import {
  assertCompleteSearchResult,
  attemptInitialCallbackRegistration,
  boundedInteger,
  canPerformMutation,
  countActionableInboundFailures,
  effectiveTask,
  evaluateEventStatus,
  evaluateHealth,
  isBareMention,
  interactiveInboundRateLimitPolicy,
  isMulticaSyncStale,
  finalInboundFailurePolicy,
  planPollWindow,
  shouldObserveWithoutReply,
  validateInboundPayload,
} from './reliability.mjs';

{
  const unavailable = new Error('provider callback temporarily unavailable');
  let deferredError = null;
  const deferred = await attemptInitialCallbackRegistration(
    async () => { throw unavailable; },
    { onDeferred: async error => { deferredError = error; } },
  );
  assert.equal(deferred.registered, false);
  assert.equal(deferred.error, unavailable);
  assert.equal(deferredError, unavailable);
  assert.deepEqual(
    await attemptInitialCallbackRegistration(async () => {}),
    { registered: true, error: null },
  );
}

{
  const directory = await mkdtemp(join(tmpdir(), 'aipro-operational-health-'));
  try {
    const state = new AgentState(join(directory, 'state.sqlite'));
    state.enqueueInbound('dead-unacknowledged', 'test', {});
    state.claimInbound('dead-unacknowledged');
    state.deadLetterInbound('dead-unacknowledged', 'failed');
    state.enqueueInbound('dead-acknowledged', 'test', {});
    state.claimInbound('dead-acknowledged');
    state.deadLetterInbound('dead-acknowledged', 'failed');
    state.audit('inbound_failed_final', {
      messageId: 'dead-acknowledged',
      detail: { userNotified: true },
    });
    assert.equal(countActionableInboundFailures(state.db, {
      overdueBefore: new Date(Date.now() - 60_000).toISOString(),
    }), 1);
    state.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

{
  const nowMs = Date.parse('2026-08-22T01:00:00.000Z');
  assert.equal(isMulticaSyncStale({
    nowMs,
    lastCompletedAt: '2026-08-22T00:58:00.000Z',
    lastStartedAt: '2026-08-22T00:59:30.000Z',
    syncIntervalMs: 10_000,
    maxCycleMs: 5 * 60_000,
  }), false);
  assert.equal(isMulticaSyncStale({
    nowMs,
    lastCompletedAt: '2026-08-22T00:58:00.000Z',
    lastStartedAt: '2026-08-22T00:50:00.000Z',
    syncIntervalMs: 10_000,
    maxCycleMs: 5 * 60_000,
  }), true);
}

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
