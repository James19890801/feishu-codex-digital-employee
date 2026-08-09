import assert from 'node:assert/strict';
import {
  redactGroupHostError,
  runGroupHostWorkerIteration,
} from './group-host-worker.mjs';

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
  chatId: 'dingtalk:group:test',
  senderId: 'dingtalk:member-a',
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
    chatId: 'dingtalk:group:test',
    senderId: 'dingtalk:member-a',
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
    chatId: 'dingtalk:group:test',
    senderId: 'dingtalk:member-a',
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
    chatId: 'dingtalk:group:test',
    senderId: 'dingtalk:member-a',
    attempts: 1,
  },
  errorCode: 'state_retry_error',
});

console.log('GROUP_HOST_WORKER_TEST_OK');
