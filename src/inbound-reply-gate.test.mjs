import assert from 'node:assert/strict';
import {
  enforceInboundReplyGate,
  takeoverDeferralRetryAt,
} from './inbound-reply-gate.mjs';

const message = {
  message_id: 'message-1',
  chat_id: 'enterpriseChat:user:peer',
  create_time: '2000',
};
let syncCalls = 0;
const deferred = enforceInboundReplyGate({
  context: { message, metadata: { channel: 'enterpriseChat' } },
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
  chatId: 'enterpriseChat:user:other',
  sync: async () => { throw new Error('must not sync unrelated outbound'); },
  readTakeover: () => null,
}), { action: 'allow', untilMs: 0, reason: 'not_inbound_reply' });

await assert.rejects(enforceInboundReplyGate({
  context: { message, metadata: {} },
  chatId: message.chat_id,
  sync: async () => { throw new Error('history unavailable'); },
  readTakeover: () => null,
}), /history unavailable/);

console.log('INBOUND_REPLY_GATE_TEST_OK');
