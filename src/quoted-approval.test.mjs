import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentState } from './state.mjs';
import {
  QuotedApprovalStore,
  isDingTalkGroupApprovalContext,
  isQuotedApprovalConsent,
  isVerifiedDingTalkGroupApprover,
} from './quoted-approval.mjs';

const dir = mkdtempSync(join(tmpdir(), 'aipro-quoted-approval-'));
try {
  const state = new AgentState(join(dir, 'state.sqlite'));
  const store = new QuotedApprovalStore(state, { ttlMs: 60_000, maxRecords: 3 });
  const pending = {
    kind: 'multica',
    chatId: 'dingtalk:group:cid-1',
    requesterId: 'dingtalk:member-1',
    sourceMessageId: 'dingtalk:source-1',
    pending: { plan: { action: 'update', summary: '更新 MYS-1' } },
  };

  assert.equal(store.bind('', pending, 1_000), false);
  assert.equal(store.bind('approval-message-1', pending, 1_000), true);
  assert.equal(store.bind('approval-message-1', pending, 1_001), false);
  assert.equal(store.peek('dingtalk:approval-message-1', 2_000).requesterId, 'dingtalk:member-1');
  assert.deepEqual(store.pendingChatIds(2_000), ['dingtalk:group:cid-1']);

  assert.deepEqual(
    store.claim('approval-message-1', { chatId: 'dingtalk:group:cid-other' }, 2_100),
    { ok: false, reason: 'chat_mismatch', record: null },
  );
  assert.ok(store.peek('approval-message-1', 2_101), 'cross-chat attempts must not consume');

  const claimed = store.claim(
    'dingtalk:approval-message-1',
    { chatId: 'dingtalk:group:cid-1' },
    2_200,
  );
  assert.equal(claimed.ok, true);
  assert.equal(claimed.record.pending.plan.action, 'update');
  assert.deepEqual(
    store.claim('approval-message-1', { chatId: 'dingtalk:group:cid-1' }, 2_201),
    { ok: false, reason: 'not_found', record: null },
  );

  assert.equal(store.bind('approval-expired', pending, 3_000), true);
  assert.deepEqual(
    store.claim('approval-expired', { chatId: 'dingtalk:group:cid-1' }, 63_001),
    { ok: false, reason: 'expired', record: null },
  );
  assert.deepEqual(store.pendingChatIds(63_001), []);

  assert.equal(isQuotedApprovalConsent('同意'), true);
  assert.equal(isQuotedApprovalConsent('同意。'), true);
  assert.equal(isQuotedApprovalConsent('同意！'), true);
  assert.equal(isQuotedApprovalConsent('我同意'), false);
  assert.equal(isQuotedApprovalConsent('同意发布'), false);

  const ownerGroupContext = {
    chatId: 'dingtalk:group:cid-1',
    chatType: 'group',
    senderId: 'dingtalk:owner-open-id',
    metadata: { channel: 'dingtalk' },
  };
  assert.equal(isDingTalkGroupApprovalContext(ownerGroupContext), true);
  assert.equal(isVerifiedDingTalkGroupApprover(
    ownerGroupContext,
    { dingtalkOwnerOpenId: 'owner-open-id' },
  ), true);
  assert.equal(isVerifiedDingTalkGroupApprover(
    { ...ownerGroupContext, senderId: 'dingtalk:other' },
    { dingtalkOwnerOpenId: 'owner-open-id' },
  ), false);
  assert.equal(isDingTalkGroupApprovalContext({
    ...ownerGroupContext,
    chatType: 'p2p',
  }), false);

  console.log('QUOTED_APPROVAL_TEST_OK');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
