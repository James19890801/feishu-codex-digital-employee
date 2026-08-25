import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as inboundReplyGate from './inbound-reply-gate.mjs';
import {
  buildFailureAuditDetail,
  buildInboundAuditRecord,
  buildOutboundLedgerMetadata,
  enforceInboundReplyGate,
  takeoverDeferralRetryAt,
} from './inbound-reply-gate.mjs';
import { AgentState } from './state.mjs';

const message = {
  message_id: 'message-1',
  chat_id: 'dingtalk:user:peer',
  create_time: '2000',
};
assert.deepEqual(buildOutboundLedgerMetadata({ message }), {
  outbound: true,
  replyToMessageId: 'message-1',
});
assert.deepEqual(buildOutboundLedgerMetadata(null), { outbound: true });
assert.deepEqual(buildInboundAuditRecord({
  message,
  sender: { sender_id: { open_id: 'sender-1' } },
}, { error: 'PROCESS_TIMEOUT' }), {
  chatId: 'dingtalk:user:peer',
  senderId: 'sender-1',
  messageId: 'message-1',
  detail: { error: 'PROCESS_TIMEOUT' },
});
assert.deepEqual(buildInboundAuditRecord(null, { runtime: 'codex' }), {
  chatId: '',
  senderId: '',
  messageId: '',
  detail: { runtime: 'codex' },
});
{
  const failure = new Error('safe failure summary');
  failure.code = 'DINGTALK_SEND_PROCESS_FAILED';
  failure.phase = 'status';
  failure.retryable = false;
  failure.processRetryable = true;
  failure.localAttempts = 2;
  assert.deepEqual(buildFailureAuditDetail(failure), {
    error: 'safe failure summary',
    errorCode: 'DINGTALK_SEND_PROCESS_FAILED',
    failurePhase: 'status',
    retryable: false,
    processRetryable: true,
    localAttempts: 2,
  });
  assert.deepEqual(buildFailureAuditDetail(failure, { prefix: 'processing' }), {
    processingError: 'safe failure summary',
    processingErrorCode: 'DINGTALK_SEND_PROCESS_FAILED',
    processingFailurePhase: 'status',
    processingRetryable: false,
    processingProcessRetryable: true,
    processingLocalAttempts: 2,
  });
}
let syncCalls = 0;
const deferred = enforceInboundReplyGate({
  context: { message, metadata: { channel: 'dingtalk' } },
  chatId: message.chat_id,
  sync: async () => { syncCalls += 1; },
  readTakeover: () => ({
    pausedUntilMs: 10_000,
    lastActivityOccurredAtMs: 1_000,
    reason: 'owner_manual_activity',
  }),
  nowMs: 3_000,
});
await assert.rejects(deferred, error => (
  error.code === 'HUMAN_TAKEOVER_DEFERRED' && error.retryAtMs === 10_000
));
assert.equal(syncCalls, 1);
assert.equal(
  takeoverDeferralRetryAt({ code: 'HUMAN_TAKEOVER_DEFERRED', retryAtMs: 10_000 }, 3_000),
  '1970-01-01T00:00:10.000Z',
);

assert.deepEqual(await enforceInboundReplyGate({
  context: { message, metadata: {} },
  chatId: message.chat_id,
  sync: async () => {},
  readTakeover: () => ({
    pausedUntilMs: 10_000,
    lastActivityOccurredAtMs: 4_000,
    reason: 'owner_manual_activity',
  }),
  nowMs: 5_000,
}), { action: 'resolved', untilMs: 0, reason: 'owner_replied_after_message' });

assert.deepEqual(await enforceInboundReplyGate({
  context: { message, metadata: {} },
  chatId: 'dingtalk:user:other',
  sync: async () => { throw new Error('must not sync unrelated outbound'); },
  readTakeover: () => null,
}), { action: 'allow', untilMs: 0, reason: 'not_inbound_reply' });

await assert.rejects(enforceInboundReplyGate({
  context: { message, metadata: {} },
  chatId: message.chat_id,
  sync: async () => { throw new Error('history unavailable'); },
  readTakeover: () => null,
}), /history unavailable/);

const terminalGateAudits = [];
assert.deepEqual(await enforceInboundReplyGate({
  context: { message, metadata: { inboundAttemptNumber: 3 } },
  chatId: message.chat_id,
  sync: async () => { throw new Error('history unavailable'); },
  readTakeover: () => null,
  audit: (...args) => terminalGateAudits.push(args),
}), {
  action: 'resolved',
  untilMs: 0,
  reason: 'takeover_control_unavailable',
});
assert.deepEqual(terminalGateAudits.map(([event]) => event), [
  'message_skipped_takeover_control_unavailable',
]);

assert.equal(
  typeof inboundReplyGate.finalizeExhaustedInboundFailure,
  'function',
  'exhausted processing failures must have a silent dead-letter policy',
);
const stateDir = mkdtempSync(join(tmpdir(), 'aipr0s-inbound-final-failure-'));
try {
  const failureState = new AgentState(join(stateDir, 'state.sqlite'));
  const failedMessage = {
    message_id: 'message-final-failure',
    chat_id: 'dingtalk:user:peer',
    chat_type: 'p2p',
    content: JSON.stringify({ text: '请处理这条消息' }),
  };
  const sender = { sender_type: 'user', sender_id: { open_id: 'sender-1' } };
  failureState.enqueueInbound(
    failedMessage.message_id,
    'websocket-dingtalk-dws',
    { message: failedMessage, sender },
    '2026-08-13T03:48:00.000Z',
  );
  failureState.claimInbound(failedMessage.message_id, '2026-08-13T03:48:00.000Z');
  failureState.failInbound(
    failedMessage.message_id,
    'Codex CLI failed: PROCESS_EXIT',
    '2026-08-13T03:48:02.000Z',
    '2026-08-13T03:48:01.000Z',
  );
  failureState.claimInbound(failedMessage.message_id, '2026-08-13T03:48:02.000Z');
  failureState.failInbound(
    failedMessage.message_id,
    'Codex CLI failed: PROCESS_EXIT',
    '2026-08-13T03:48:04.000Z',
    '2026-08-13T03:48:03.000Z',
  );
  failureState.claimInbound(failedMessage.message_id, '2026-08-13T03:48:04.000Z');

  inboundReplyGate.finalizeExhaustedInboundFailure({
    state: failureState,
    message: failedMessage,
    sender,
    source: 'websocket-dingtalk-dws',
    attemptNumber: 3,
    error: new Error('Codex CLI failed: PROCESS_EXIT'),
    now: '2026-08-13T03:48:05.000Z',
  });

  const stored = failureState.getInbound(failedMessage.message_id);
  assert.equal(stored.status, 'dead');
  assert.equal(stored.attempts, 3);
  assert.equal(stored.lastError, 'Error: Codex CLI failed: PROCESS_EXIT');
  assert.deepEqual(failureState.history(failedMessage.chat_id, sender.sender_id.open_id), []);
  const auditRow = failureState.db.prepare(
    `SELECT event, chat_id, sender_id, message_id, detail
      FROM audit WHERE message_id = ? ORDER BY id DESC LIMIT 1`,
  ).get(failedMessage.message_id);
  assert.deepEqual({ ...auditRow, detail: JSON.parse(auditRow.detail) }, {
    event: 'inbound_dead_lettered',
    chat_id: failedMessage.chat_id,
    sender_id: sender.sender_id.open_id,
    message_id: failedMessage.message_id,
    detail: {
      source: 'websocket-dingtalk-dws',
      attemptNumber: 3,
      processingError: 'Codex CLI failed: PROCESS_EXIT',
      userNoticeSuppressed: true,
    },
  });
  failureState.close();
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}

const historyFailureDir = mkdtempSync(join(tmpdir(), 'aipr0s-history-final-failure-'));
try {
  const historyFailureState = new AgentState(join(historyFailureDir, 'state.sqlite'));
  const failedMessage = {
    message_id: 'message-history-unavailable',
    chat_id: 'dingtalk:user:peer',
    chat_type: 'p2p',
    content: JSON.stringify({ text: 'redacted-reproduction' }),
  };
  const sender = { sender_type: 'user', sender_id: { open_id: 'sender-1' } };
  historyFailureState.enqueueInbound(
    failedMessage.message_id,
    'websocket-dingtalk-dws',
    { message: failedMessage, sender },
    '2026-08-13T03:48:00.000Z',
  );
  historyFailureState.claimInbound(failedMessage.message_id, '2026-08-13T03:48:00.000Z');
  const historyError = new Error('conversation history unavailable');
  historyError.code = 'CONVERSATION_HISTORY_UNAVAILABLE';

  const result = inboundReplyGate.finalizeExhaustedInboundFailure({
    state: historyFailureState,
    message: failedMessage,
    sender,
    source: 'websocket-dingtalk-dws',
    attemptNumber: 3,
    error: historyError,
    now: '2026-08-13T03:48:05.000Z',
  });

  assert.deepEqual(result, { action: 'skip', userNoticeSent: false });
  assert.equal(historyFailureState.getInbound(failedMessage.message_id).status, 'completed');
  const auditRow = historyFailureState.db.prepare(
    `SELECT event, detail FROM audit WHERE message_id = ? ORDER BY id DESC LIMIT 1`,
  ).get(failedMessage.message_id);
  assert.equal(auditRow.event, 'message_skipped_history_unavailable');
  assert.equal(JSON.parse(auditRow.detail).reason, 'conversation_history_unavailable');
  historyFailureState.close();
} finally {
  rmSync(historyFailureDir, { recursive: true, force: true });
}

const sendFailureDir = mkdtempSync(join(tmpdir(), 'aipr0s-send-final-failure-'));
try {
  const sendFailureState = new AgentState(join(sendFailureDir, 'state.sqlite'));
  const failedMessage = {
    message_id: 'message-send-process-failure',
    chat_id: 'dingtalk:user:peer',
    chat_type: 'p2p',
    content: JSON.stringify({ text: 'redacted-reproduction' }),
  };
  const sender = { sender_type: 'user', sender_id: { open_id: 'sender-1' } };
  sendFailureState.enqueueInbound(
    failedMessage.message_id,
    'websocket-dingtalk-dws',
    { message: failedMessage, sender },
    '2026-08-21T03:48:00.000Z',
  );
  sendFailureState.claimInbound(failedMessage.message_id, '2026-08-21T03:48:00.000Z');
  const sendError = new Error('DingTalk send status failed: PROCESS_EXIT');
  sendError.code = 'DINGTALK_SEND_PROCESS_FAILED';
  sendError.phase = 'status';
  sendError.retryable = false;
  sendError.processRetryable = true;
  sendError.localAttempts = 2;

  const result = inboundReplyGate.finalizeExhaustedInboundFailure({
    state: sendFailureState,
    message: failedMessage,
    sender,
    source: 'websocket-dingtalk-dws',
    attemptNumber: 1,
    error: sendError,
    now: '2026-08-21T03:48:05.000Z',
  });

  assert.deepEqual(result, { action: 'dead_letter', userNoticeSent: false });
  assert.equal(sendFailureState.getInbound(failedMessage.message_id).status, 'dead');
  const auditRow = sendFailureState.db.prepare(
    `SELECT event, detail FROM audit WHERE message_id = ? ORDER BY id DESC LIMIT 1`,
  ).get(failedMessage.message_id);
  const detail = JSON.parse(auditRow.detail);
  assert.equal(auditRow.event, 'inbound_dead_lettered');
  assert.equal(detail.processingErrorCode, 'DINGTALK_SEND_PROCESS_FAILED');
  assert.equal(detail.processingFailurePhase, 'status');
  assert.equal(detail.processingProcessRetryable, true);
  assert.equal(detail.processingLocalAttempts, 2);
  assert.equal(detail.userNoticeSuppressed, true);
  sendFailureState.close();
} finally {
  rmSync(sendFailureDir, { recursive: true, force: true });
}

console.log('INBOUND_REPLY_GATE_TEST_OK');
