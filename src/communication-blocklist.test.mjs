import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentState } from './state.mjs';
import {
  applyAutomaticInboundBlock,
  automaticCommunicationDecision,
  canSendBlockedRecipient,
  normalizeCommunicationBlocklist,
} from './communication-blocklist.mjs';

const blocklist = normalizeCommunicationBlocklist([{
  channel: 'dingtalk',
  displayName: '受保护联系人',
  userId: '303509',
  openId: 'DZShVINWxiSe70fNkE84kZiiJB41gumdvbO',
}]);

assert.equal(blocklist.length, 1);
assert.equal(automaticCommunicationDecision({
  senderId: 'dingtalk:DZShVINWxiSe70fNkE84kZiiJB41gumdvbO',
  chatId: 'dingtalk:user:DZShVINWxiSe70fNkE84kZiiJB41gumdvbO',
}, blocklist).blocked, true);
assert.equal(automaticCommunicationDecision({
  senderId: '',
  chatId: 'dingtalk:user:DZShVINWxiSe70fNkE84kZiiJB41gumdvbO',
}, blocklist).blocked, true, 'direct automatic notifications must be blocked by target ID');
assert.equal(automaticCommunicationDecision({
  senderId: 'dingtalk:DZShVINWxiSe70fNkE84kZiiJB41gumdvbO',
  chatId: 'dingtalk:group:cid-group',
}, blocklist).blocked, true, 'a blocked sender must stay blocked inside groups');
assert.equal(automaticCommunicationDecision({
  senderId: 'dingtalk:someone-else',
  senderName: '受保护联系人',
  chatId: 'dingtalk:user:someone-else',
}, blocklist).blocked, false, 'display names are labels, never enforcement identities');
assert.equal(canSendBlockedRecipient({ blocked: true, explicitOwnerAuthorized: false }), false);
assert.equal(canSendBlockedRecipient({ blocked: true, explicitOwnerAuthorized: true }), true);
assert.equal(canSendBlockedRecipient({ blocked: false, explicitOwnerAuthorized: false }), true);

const directory = await mkdtemp(join(tmpdir(), 'communication-blocklist-'));
const state = new AgentState(join(directory, 'state.sqlite'));
try {
  const payload = {
    message: {
      message_id: 'blocked-message-1',
      chat_id: 'dingtalk:user:DZShVINWxiSe70fNkE84kZiiJB41gumdvbO',
    },
    sender: { sender_id: { open_id: 'dingtalk:DZShVINWxiSe70fNkE84kZiiJB41gumdvbO' } },
  };
  assert.equal(applyAutomaticInboundBlock({
    payload,
    source: 'websocket-dingtalk-dws',
    blocklist,
    state,
  }), true);
  assert.equal(state.hasInbound('blocked-message-1'), true);
  assert.deepEqual(state.listReadyInbound(new Date().toISOString(), 10), []);
  assert.equal(state.inboxStatusCounts().completed, 1);

  const queuedPayload = {
    ...payload,
    message: { ...payload.message, message_id: 'blocked-message-already-queued' },
  };
  assert.equal(state.enqueueInbound(
    'blocked-message-already-queued',
    'websocket-dingtalk-dws',
    queuedPayload,
  ), true);
  assert.equal(applyAutomaticInboundBlock({
    payload: queuedPayload,
    source: 'stored-inbound',
    blocklist,
    state,
  }), true);
  assert.equal(state.inboxStatusCounts().pending || 0, 0);
  assert.equal(state.inboxStatusCounts().completed, 2);
} finally {
  state.close();
  await rm(directory, { recursive: true, force: true });
}

console.log('COMMUNICATION_BLOCKLIST_TEST_OK');
