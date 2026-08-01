import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PendingActionStore } from './pending-actions.mjs';
import { AgentState } from './state.mjs';

const dir = mkdtempSync(join(tmpdir(), 'xiaozhao-pending-'));
try {
  const state = new AgentState(join(dir, 'state.sqlite'));
  const pending = new PendingActionStore(state, { ttlMs: 60_000 });
  const due = new Date('2026-07-30T03:00:00.000Z');
  pending.set('task', 'oc_1', 'ou_1', { summary: '整理材料', due }, 1_000);
  const restored = pending.get('task', 'oc_1', 'ou_1', 30_000);
  assert.equal(restored.summary, '整理材料');
  assert.equal(restored.due instanceof Date, true);
  assert.equal(restored.due.toISOString(), due.toISOString());
  assert.equal(pending.get('task', 'oc_1', 'ou_1', 61_001), null);

  pending.set('calendar', 'oc_1', 'ou_1', {
    summary: '周会',
    start: new Date('2026-07-30T04:00:00.000Z'),
    end: new Date('2026-07-30T05:00:00.000Z'),
  }, 2_000);
  pending.delete('calendar', 'oc_1', 'ou_1');
  assert.equal(pending.get('calendar', 'oc_1', 'ou_1', 2_001), null);

  pending.set('multica', 'oc_1', 'ou_1', {
    confirmationCode: '482731',
    pending: {
      plan: { action: 'create', fields: { title: 'Commercial launch' } },
    },
  }, 3_000);
  assert.equal(
    pending.get('multica', 'oc_1', 'ou_1', 3_001).pending.plan.action,
    'create',
  );

  pending.set('multica_feedback', 'dingtalk:user:owner', 'dingtalk:owner', {
    originalRequest: '创建一个培训课件 Issue',
    sourceMessageId: 'message-feedback-1',
    context: {
      chatId: 'dingtalk:user:owner',
      senderId: 'dingtalk:owner',
      chatType: 'p2p',
      metadata: { channel: 'dingtalk', selfChat: true },
    },
  }, 4_000);
  assert.equal(
    pending.get(
      'multica_feedback',
      'dingtalk:user:owner',
      'dingtalk:owner',
      4_001,
    ).originalRequest,
    '创建一个培训课件 Issue',
  );
  console.log('PENDING_ACTIONS_TEST_OK');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
