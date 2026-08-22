import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentState } from './state.mjs';

const dir = mkdtempSync(join(tmpdir(), 'owner-consultation-state-'));
try {
  const state = new AgentState(join(dir, 'state.sqlite'));
  const base = {
    id: 'consult-1', channel: 'wechat', ownerId: 'wechat:fung5115',
    ownerChatId: 'wechat:user:fung5115', originChatId: 'wechat:user:friend-1',
    originChatType: 'p2p', requesterId: 'wechat:friend-1', requesterLabel: '一尘老师',
    sourceMessageId: 'wechat:message-1', requestText: '下周能否交流？',
    decisionPrompt: '是否同意进一步交流', suggestedReply: '可以进一步沟通。',
    reminderAtMs: 15_000, expiresAtMs: 25_000, nowMs: 1_000,
  };

  const created = state.createOwnerConsultation(base);
  assert.equal(created.created, true);
  assert.equal(created.consultation.status, 'pending_notify');
  const duplicate = state.createOwnerConsultation({ ...base, id: 'consult-other' });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.consultation.id, 'consult-1');

  assert.equal(state.claimOwnerConsultationNotification('consult-1', 2_000).status, 'notifying_owner');
  assert.equal(state.claimOwnerConsultationNotification('consult-1', 2_001), null);
  assert.equal(state.markOwnerConsultationAwaiting('consult-1', 'owner-message-1', 3_000), true);
  assert.equal(state.ownerConsultationByNotificationMessageId('owner-message-1').id, 'consult-1');
  assert.deepEqual(state.activeOwnerConsultations('wechat:fung5115', 4_000).map(item => item.id), ['consult-1']);

  const resolving = state.claimOwnerConsultationResolution('consult-1', {
    decision: 'approve', approvedReply: '可以进一步沟通。', ownerResponseMessageId: 'owner-response-1', nowMs: 5_000,
  });
  assert.equal(resolving.status, 'resolving');
  assert.equal(state.claimOwnerConsultationResolution('consult-1', {
    decision: 'approve', approvedReply: '重复', ownerResponseMessageId: 'owner-response-2', nowMs: 5_001,
  }), null);
  assert.equal(state.markOwnerConsultationRelayed('consult-1', 'relayed', 6_000), true);
  assert.equal(state.ownerConsultationById('consult-1').status, 'relayed');

  state.createOwnerConsultation({
    ...base, id: 'consult-2', sourceMessageId: 'wechat:message-2',
    reminderAtMs: 10_000, expiresAtMs: 20_000,
  });
  state.claimOwnerConsultationNotification('consult-2', 2_000);
  state.markOwnerConsultationAwaiting('consult-2', 'owner-message-2', 3_000);
  assert.equal(state.claimDueOwnerConsultationReminder(9_999), null);
  assert.equal(state.claimDueOwnerConsultationReminder(10_000).id, 'consult-2');
  assert.equal(state.claimDueOwnerConsultationReminder(10_001), null);
  assert.equal(state.markOwnerConsultationAwaiting('consult-2', 'owner-message-2', 10_002, { reminded: true }), true);
  assert.equal(state.claimDueOwnerConsultationExpiry(19_999), null);
  assert.equal(state.claimDueOwnerConsultationExpiry(20_000).id, 'consult-2');
  assert.equal(state.claimDueOwnerConsultationExpiry(20_001), null);
  assert.equal(state.markOwnerConsultationRelayed('consult-2', 'expired', 20_002), true);

  state.createOwnerConsultation({ ...base, id: 'consult-3', sourceMessageId: 'wechat:message-3' });
  assert.equal(state.markOwnerConsultationAmbiguous('consult-3', 'owner_notify', 'timeout', 3_000), true);
  assert.equal(state.ownerConsultationById('consult-3').status, 'owner_notify_ambiguous');

  state.close();
  console.log('OWNER_CONSULTATION_STATE_TEST_OK');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
