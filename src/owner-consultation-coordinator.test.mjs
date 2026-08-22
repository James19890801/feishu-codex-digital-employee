import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerConsultationCoordinator } from './owner-consultation.mjs';
import { AgentState } from './state.mjs';

const dir = mkdtempSync(join(tmpdir(), 'owner-consultation-coordinator-'));
try {
  const state = new AgentState(join(dir, 'state.sqlite'));
  const sent = [];
  const audits = [];
  let nowMs = 1_000;
  let nextId = 1;
  const coordinator = new OwnerConsultationCoordinator({
    state,
    ownerIds: ['fung5115'],
    now: () => nowMs,
    idFactory: () => `consult-${nextId++}`,
    executeOnce: async ({ operation }) => ({ result: await operation(), replayed: false }),
    send: async input => {
      sent.push(input);
      return { messageId: `sent-${sent.length}` };
    },
    audit: (event, detail) => audits.push({ event, detail }),
  });

  const started = await coordinator.start({
    message: { message_id: 'm-1', chat_id: 'wechat:user:friend-1', chat_type: 'p2p' },
    senderId: 'wechat:friend-1', text: '请问詹老师是否同意下周交流？', requesterLabel: '一尘老师',
  });
  assert.equal(started.handled, true);
  assert.equal(sent[0].chatId, 'wechat:user:friend-1');
  assert.match(sent[0].text, /好的，我去问詹老师/);
  assert.equal(sent[1].chatId, 'wechat:user:fung5115');
  assert.match(sent[1].text, /一尘老师/);
  assert.doesNotMatch(sent[1].text, /consult-1/);
  assert.equal(state.ownerConsultationById('consult-1').ownerNotificationMessageId, 'sent-2');

  const spoof = await coordinator.handleOwnerResponse({
    senderId: 'wechat:not-owner', chatId: 'wechat:user:not-owner', chatType: 'p2p',
    text: '同意', messageId: 'spoof-1', quotedMessageId: 'sent-2',
  });
  assert.equal(spoof.handled, false);

  const approved = await coordinator.handleOwnerResponse({
    senderId: 'wechat:fung5115', chatId: 'wechat:user:fung5115', chatType: 'p2p',
    text: '同意', messageId: 'owner-response-1', quotedMessageId: 'sent-2',
  });
  assert.equal(approved.handled, true);
  assert.equal(approved.action, 'relayed');
  assert.equal(sent.at(-1).chatId, 'wechat:user:friend-1');
  assert.match(sent.at(-1).text, /我问过詹老师了/);
  assert.equal(state.ownerConsultationById('consult-1').status, 'relayed');

  const duplicate = await coordinator.handleOwnerResponse({
    senderId: 'wechat:fung5115', chatId: 'wechat:user:fung5115', chatType: 'p2p',
    text: '同意', messageId: 'owner-response-1', quotedMessageId: 'sent-2',
  });
  assert.equal(duplicate.action, 'already_closed');

  nowMs = 2_000;
  await coordinator.start({
    message: { message_id: 'm-2', chat_id: 'wechat:group:room@chatroom', chat_type: 'group' },
    senderId: 'wechat:member-2', text: '你去问詹老师，这次分享能不能安排？', requesterLabel: '小雅姐姐',
  });
  const secondOwnerMessageId = state.ownerConsultationById('consult-2').ownerNotificationMessageId;
  const revised = await coordinator.handleOwnerResponse({
    senderId: 'wechat:fung5115', chatId: 'wechat:user:fung5115', chatType: 'p2p',
    text: '告诉她：可以，时间另约', messageId: 'owner-response-2', quotedMessageId: secondOwnerMessageId,
  });
  assert.equal(revised.action, 'relayed');
  assert.equal(sent.at(-1).chatId, 'wechat:group:room@chatroom');
  assert.equal(sent.at(-1).mentionSenderId, 'wechat:member-2');
  assert.match(sent.at(-1).text, /可以，时间另约/);

  nowMs = 2_500;
  const contextual = await coordinator.start({
    message: { message_id: 'm-context', chat_id: 'wechat:user:friend-context', chat_type: 'p2p' },
    senderId: 'wechat:friend-context', text: '好，你去问吧', requesterLabel: '联系人丙',
    recentAssistantText: '这个需要詹老师确认，要我去问詹老师吗？',
  });
  assert.equal(contextual.handled, true);

  nowMs = 3_000;
  await coordinator.start({
    message: { message_id: 'm-3', chat_id: 'wechat:user:friend-3', chat_type: 'p2p' },
    senderId: 'wechat:friend-3', text: '帮我问詹老师是否参加？', requesterLabel: '联系人甲',
  });
  await coordinator.start({
    message: { message_id: 'm-4', chat_id: 'wechat:user:friend-4', chat_type: 'p2p' },
    senderId: 'wechat:friend-4', text: '请詹老师确认是否可以？', requesterLabel: '联系人乙',
  });
  const ambiguousCount = sent.length;
  const ambiguous = await coordinator.handleOwnerResponse({
    senderId: 'wechat:fung5115', chatId: 'wechat:user:fung5115', chatType: 'p2p',
    text: '同意', messageId: 'owner-response-3', quotedMessageId: '',
  });
  assert.equal(ambiguous.action, 'needs_quote');
  assert.equal(sent.length, ambiguousCount + 1);
  assert.match(sent.at(-1).text, /引用对应的请示消息/);

  assert.ok(audits.every(item => !JSON.stringify(item.detail).includes('下周交流')));
  state.close();

  const dueState = new AgentState(join(dir, 'due-state.sqlite'));
  const dueSent = [];
  let dueNow = 10_000;
  const dueCoordinator = new OwnerConsultationCoordinator({
    state: dueState, ownerIds: ['fung5115'], now: () => dueNow,
    idFactory: () => 'due-1', reminderMs: 4 * 60 * 60_000, ttlMs: 24 * 60 * 60_000,
    executeOnce: async ({ operation }) => ({ result: await operation(), replayed: false }),
    send: async input => { dueSent.push(input); return { messageId: `due-sent-${dueSent.length}` }; },
  });
  await dueCoordinator.start({
    message: { message_id: 'due-m-1', chat_id: 'wechat:user:due-friend', chat_type: 'p2p' },
    senderId: 'wechat:due-friend', text: '请詹老师确认是否同意。', requesterLabel: '联系人',
  });
  dueNow += 4 * 60 * 60_000;
  await dueCoordinator.processDue();
  assert.match(dueSent.at(-1).text, /提醒/);
  assert.equal(dueState.ownerConsultationById('due-1').status, 'awaiting_owner');
  assert.ok(dueState.ownerConsultationById('due-1').remindedAtMs > 0);
  dueNow = 10_000 + 24 * 60 * 60_000;
  await dueCoordinator.processDue();
  assert.match(dueSent.at(-1).text, /这次请示先结束/);
  assert.equal(dueState.ownerConsultationById('due-1').status, 'expired');
  dueState.close();

  const ackState = new AgentState(join(dir, 'ack-state.sqlite'));
  const ackSent = [];
  let ackAttempts = 0;
  const ackCoordinator = new OwnerConsultationCoordinator({
    state: ackState,
    ownerIds: ['fung5115'],
    idFactory: () => 'ack-1',
    executeOnce: async ({ operation }) => ({ result: await operation(), replayed: false }),
    send: async input => {
      ackAttempts += 1;
      if (ackAttempts === 1) throw new Error('ack outcome unknown');
      ackSent.push(input);
      return { messageId: 'ack-owner-message' };
    },
  });
  const ackRecovered = await ackCoordinator.start({
    message: { message_id: 'ack-m-1', chat_id: 'wechat:user:ack-friend', chat_type: 'p2p' },
    senderId: 'wechat:ack-friend', text: '麻烦问一下詹老师是否同意。', requesterLabel: '联系人',
  });
  assert.equal(ackRecovered.action, 'awaiting_owner');
  assert.equal(ackSent.length, 1);
  assert.equal(ackSent[0].chatId, 'wechat:user:fung5115');
  assert.equal(ackState.ownerConsultationById('ack-1').status, 'awaiting_owner');
  ackState.close();
  console.log('OWNER_CONSULTATION_COORDINATOR_TEST_OK');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
