import assert from 'node:assert/strict';
import {
  buildGroupHostHealthSnapshot,
  groupHostTransition,
  redactGroupHostError,
  runGroupHostWorkerIteration,
} from './group-host-worker.mjs';

assert.deepEqual(groupHostTransition({
  action: 'deferred', reasonCode: 'recent_group_activity', dueAtMs: 25_000,
}), {
  kind: 'reschedule',
  dueAtMs: 25_000,
  resolution: 'recent_group_activity',
});
assert.deepEqual(groupHostTransition({
  action: 'replied', reasonCode: 'silent_public_topic', reply: 'private reply text',
}), { kind: 'complete', resolution: 'host_replied' });
assert.deepEqual(groupHostTransition({
  action: 'human_picked_up', reasonCode: 'related_human_reply',
}), { kind: 'complete', resolution: 'human_picked_up' });
assert.deepEqual(groupHostTransition({
  action: 'suppressed', reasonCode: 'chat_not_allowlisted',
}), { kind: 'complete', resolution: 'suppressed_chat_not_allowlisted' });

assert.deepEqual(buildGroupHostHealthSnapshot({
  enabled: true,
  allowlistedGroups: 1,
  stats: { pending: 2, processing: 0, completed: 5, dead: 0, due: 1 },
  iteration: { action: 'claim_error', errorCode: 'state_claim_error' },
  previous: { lastResolvedAt: '2026-08-09T00:00:00.000Z' },
  nowMs: Date.parse('2026-08-09T01:00:00.000Z'),
}), {
  enabled: true,
  allowlistedGroups: 1,
  pending: 2,
  processing: 0,
  completed: 5,
  dead: 0,
  due: 1,
  lastCheckAt: '2026-08-09T01:00:00.000Z',
  lastResolvedAt: '2026-08-09T00:00:00.000Z',
  lastError: { at: '2026-08-09T01:00:00.000Z', code: 'state_claim_error' },
});
assert.deepEqual(buildGroupHostHealthSnapshot({
  enabled: true,
  allowlistedGroups: 1,
  stats: { pending: 0, processing: 0, completed: 6, dead: 0, due: 0 },
  iteration: { action: 'handled' },
  previous: { lastError: { at: 'old', code: 'old_error' } },
  nowMs: Date.parse('2026-08-09T01:01:00.000Z'),
}).lastError, null);

const privateText = '这是不应进入健康状态或重试记录的私人群聊原文';
assert.equal(redactGroupHostError(new Error(privateText), 'claim'), 'state_claim_error');
assert.equal(redactGroupHostError(Object.assign(new Error(privateText), {
  code: 'PROCESS_TIMEOUT',
}), 'process'), 'process_timeout');
assert.equal(redactGroupHostError(new Error(`classifier budget exhausted ${privateText}`), 'process'), 'classifier_budget_exhausted');
assert.equal(redactGroupHostError(new Error(privateText), 'process'), 'group_host_processing_error');

assert.deepEqual(await runGroupHostWorkerIteration({
  nowMs: 10_000,
  claim: () => null,
  handle: async () => { throw new Error('must not handle'); },
  retry: () => { throw new Error('must not retry'); },
}), { action: 'idle', waitMs: 1_000 });

const candidate = {
  messageId: 'host-worker-1',
  chatId: 'enterpriseChat:group:test',
  senderId: 'enterpriseChat:member-a',
  text: privateText,
  attempts: 1,
};
assert.deepEqual(await runGroupHostWorkerIteration({
  nowMs: 10_000,
  claim: () => candidate,
  handle: async () => ({ action: 'observe', reasonCode: 'candidate_expired' }),
  retry: () => { throw new Error('must not retry'); },
}), {
  action: 'handled',
  waitMs: 0,
  candidate: {
    messageId: 'host-worker-1',
    chatId: 'enterpriseChat:group:test',
    senderId: 'enterpriseChat:member-a',
    attempts: 1,
  },
  handledAction: 'observe',
  reasonCode: 'candidate_expired',
});

const claimFailure = await runGroupHostWorkerIteration({
  nowMs: 10_000,
  claim: () => { throw new Error(privateText); },
  handle: async () => { throw new Error('must not handle'); },
  retry: () => { throw new Error('must not retry'); },
});
assert.deepEqual(claimFailure, {
  action: 'claim_error',
  waitMs: 2_000,
  errorCode: 'state_claim_error',
});
assert.equal(JSON.stringify(claimFailure).includes(privateText), false);

let retryArguments = null;
const processFailure = Object.assign(new Error(privateText), { code: 'PROCESS_TIMEOUT' });
const retryOutcome = await runGroupHostWorkerIteration({
  nowMs: 10_000,
  claim: () => candidate,
  handle: async () => { throw processFailure; },
  retry: (...args) => {
    retryArguments = args;
    return { updated: true, deadLettered: false, attempts: 1 };
  },
  maxAttempts: 3,
});
assert.deepEqual(retryArguments, [
  'host-worker-1', 'process_timeout', 25_000, 10_000, 3,
]);
assert.deepEqual(retryOutcome, {
  action: 'retry_scheduled',
  waitMs: 0,
  candidate: {
    messageId: 'host-worker-1',
    chatId: 'enterpriseChat:group:test',
    senderId: 'enterpriseChat:member-a',
    attempts: 1,
  },
  errorCode: 'process_timeout',
  retryAtMs: 25_000,
  attempts: 1,
});
assert.equal(JSON.stringify(retryOutcome).includes(privateText), false);
assert.equal(JSON.stringify(retryArguments).includes(privateText), false);

const deadCandidate = { ...candidate, attempts: 3 };
assert.equal((await runGroupHostWorkerIteration({
  nowMs: 20_000,
  claim: () => deadCandidate,
  handle: async () => { throw new Error(privateText); },
  retry: () => ({ updated: true, deadLettered: true, attempts: 3 }),
  maxAttempts: 3,
})).action, 'dead_lettered');

assert.deepEqual(await runGroupHostWorkerIteration({
  nowMs: 20_000,
  claim: () => candidate,
  handle: async () => { throw new Error(privateText); },
  retry: () => { throw new Error(privateText); },
}), {
  action: 'retry_error',
  waitMs: 2_000,
  candidate: {
    messageId: 'host-worker-1',
    chatId: 'enterpriseChat:group:test',
    senderId: 'enterpriseChat:member-a',
    attempts: 1,
  },
  errorCode: 'state_retry_error',
});

assert.equal((await runGroupHostWorkerIteration({
  nowMs: 20_000,
  claim: () => candidate,
  handle: async () => { throw new Error(privateText); },
  retry: () => ({ updated: false, deadLettered: false, attempts: 1 }),
})).action, 'retry_error');

console.log('GROUP_HOST_WORKER_TEST_OK');
