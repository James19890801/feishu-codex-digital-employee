import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentState } from './state.mjs';

const dir = mkdtempSync(join(tmpdir(), 'xiaozhao-state-'));
try {
  const state = new AgentState(join(dir, 'state.sqlite'));
  assert.equal(state.db.prepare('PRAGMA synchronous').get().synchronous, 2);
  state.remember('chat', 'user', 'user', '第一条');
  state.remember('chat', 'user', 'assistant', '第二条');
  assert.deepEqual(state.history('chat', 'user').map(x => x.content), ['第一条', '第二条']);
  state.set('chat', 'paused', true);
  assert.equal(state.get('chat', 'paused'), true);
  state.audit('test', { chatId: 'chat', detail: { ok: true } });

  const now = '2026-07-29T14:00:00.000Z';
  assert.equal(state.enqueueInbound('om_1', 'poll', { hello: 'world' }, now), true);
  assert.equal(state.hasInbound('om_1'), true);
  assert.equal(state.hasInbound('om_missing'), false);
  assert.equal(state.enqueueInbound('om_1', 'websocket', { ignored: true }, now), false);
  assert.equal(state.claimInbound('om_1', now), true);
  assert.equal(state.claimInbound('om_1', now), false);
  state.failInbound('om_1', 'temporary failure', '2026-07-29T14:00:01.000Z');
  assert.equal(state.claimInbound('om_1', '2026-07-29T14:00:00.500Z'), false);
  assert.equal(state.claimInbound('om_1', '2026-07-29T14:00:01.000Z'), true);
  state.completeInbound('om_1', '2026-07-29T14:00:02.000Z');
  assert.equal(state.claimInbound('om_1', '2026-07-29T14:05:00.000Z'), false);

  assert.equal(state.seedInbound('om_old', 'poll', { old: true }, now), true);
  assert.equal(state.claimInbound('om_old', '2026-07-29T14:10:00.000Z'), false);

  state.enqueueInbound('om_crash', 'poll', { crash: true }, now);
  assert.equal(state.claimInbound('om_crash', now), true);
  assert.equal(state.recoverStaleInbound('2026-07-29T14:10:00.000Z', 60_000), 1);
  assert.deepEqual(
    state.listReadyInbound('2026-07-29T14:10:00.000Z', 10).map(item => item.messageId),
    ['om_crash'],
  );
  assert.equal(state.claimInbound('om_crash', '2026-07-29T14:10:00.000Z'), true);
  assert.deepEqual(state.getInbound('om_crash').payload, { crash: true });
  state.deadLetterInbound('om_crash', 'permanent failure', '2026-07-29T14:11:00.000Z');
  assert.equal(state.getInbound('om_crash').status, 'dead');
  assert.equal(state.claimInbound('om_crash', '2026-07-29T14:12:00.000Z'), false);

  state.enqueueInbound('om_recent_crash', 'poll', { crash: true }, now);
  assert.equal(state.claimInbound('om_recent_crash', now), true);
  assert.equal(state.recoverProcessingInbound('2026-07-29T14:00:01.000Z'), 1);
  assert.equal(state.getInbound('om_recent_crash').status, 'pending');

  state.set('pending', 'one', { ok: true });
  state.unset('pending', 'one');
  assert.equal(state.get('pending', 'one', null), null);

  assert.equal(state.consumeRateLimit('sender:1', 1_000, 60_000, 2), true);
  assert.equal(state.consumeRateLimit('sender:1', 2_000, 60_000, 2), true);
  assert.equal(state.consumeRateLimit('sender:1', 3_000, 60_000, 2), false);
  assert.equal(state.consumeRateLimit('sender:1', 61_001, 60_000, 2), true);

  const issue = {
    id: 'issue-1',
    workspace_id: 'ws-1',
    identifier: 'MYS-1',
    title: 'Commercial launch',
    status: 'todo',
    priority: 'high',
    assignee_id: null,
    due_date: null,
    updated_at: '2026-07-29T14:00:00.000Z',
  };
  const baselineIssue = state.upsertMulticaIssue(issue, now);
  assert.equal(baselineIssue.isNew, true);
  assert.deepEqual(baselineIssue.changedFields, []);
  const unchangedIssue = state.upsertMulticaIssue(issue, '2026-07-29T14:00:01.000Z');
  assert.equal(unchangedIssue.isNew, false);
  assert.deepEqual(unchangedIssue.changedFields, []);
  const changedIssue = state.upsertMulticaIssue({
    ...issue,
    status: 'in_progress',
    updated_at: '2026-07-29T14:00:02.000Z',
  }, '2026-07-29T14:00:02.000Z');
  assert.deepEqual(changedIssue.changedFields, ['status']);
  assert.equal(changedIssue.before.status, 'todo');
  assert.equal(changedIssue.after.status, 'in_progress');

  state.subscribeMulticaIssue(issue.id, 'chat-1', 'user-1', now);
  state.subscribeMulticaIssue(issue.id, 'chat-1', 'user-1', now);
  assert.deepEqual(state.multicaIssueSubscribers(issue.id), [{
    chatId: 'chat-1',
    senderId: 'user-1',
  }]);
  state.unsubscribeMulticaIssue(issue.id, 'chat-1', 'user-1');
  assert.deepEqual(state.multicaIssueSubscribers(issue.id), []);

  state.subscribeMulticaGlobal('chat-2', 'user-2', now);
  state.subscribeMulticaGlobal('chat-2', 'user-2', now);
  assert.deepEqual(state.multicaGlobalSubscribers(), [{
    chatId: 'chat-2',
    senderId: 'user-2',
  }]);
  state.unsubscribeMulticaGlobal('chat-2', 'user-2');
  assert.deepEqual(state.multicaGlobalSubscribers(), []);

  assert.equal(state.enqueueMulticaNotification({
    notificationKey: 'multica-sync-test',
    issueId: issue.id,
    chatId: 'chat-1',
    senderId: 'user-1',
    content: 'Issue changed',
    availableAt: now,
  }), true);
  assert.equal(state.enqueueMulticaNotification({
    notificationKey: 'multica-sync-test',
    issueId: issue.id,
    chatId: 'chat-1',
    senderId: 'user-1',
    content: 'Issue changed',
    availableAt: now,
  }), false);
  assert.equal(state.multicaNotificationCount(), 1);
  assert.equal(state.listDueMulticaNotifications(now, 10)[0].notificationKey, 'multica-sync-test');
  state.failMulticaNotification(
    'multica-sync-test',
    'temporary error',
    '2026-07-29T14:00:05.000Z',
  );
  assert.equal(state.listDueMulticaNotifications(now, 10).length, 0);
  assert.equal(
    state.listDueMulticaNotifications('2026-07-29T14:00:05.000Z', 10)[0].attempts,
    1,
  );
  state.completeMulticaNotification('multica-sync-test');
  assert.equal(state.multicaNotificationCount(), 0);

  state.enqueueMulticaNotification({
    notificationKey: 'multica-sync-dead',
    issueId: issue.id,
    chatId: 'chat-dead',
    content: 'Never delivered',
    availableAt: now,
  });
  assert.deepEqual(
    state.failMulticaNotification(
      'multica-sync-dead',
      'failure one',
      '2026-07-29T14:00:01.000Z',
      2,
    ),
    { updated: true, deadLettered: false, attempts: 1 },
  );
  assert.deepEqual(
    state.failMulticaNotification(
      'multica-sync-dead',
      'failure two',
      '2026-07-29T14:00:02.000Z',
      2,
    ),
    { updated: true, deadLettered: true, attempts: 2 },
  );
  assert.equal(state.multicaNotificationCount(), 0);
  assert.equal(state.multicaNotificationDeadCount(), 1);
  assert.equal(
    state.listDueMulticaNotifications('2026-07-29T15:00:00.000Z', 10).length,
    0,
  );

  const a1Workitem = {
    id: '84886503',
    projectId: '2165415',
    projectName: 'WebAgent需求池',
    title: '数字员工接入 A1',
    description: '实现读取与确认写入。',
    status: '待处理',
    assignee: '阿充',
    category: 'Req',
    type: '产品类需求',
    updatedAt: '2026-08-03 10:00:00',
    url: 'https://project.aone.alibaba-inc.com/project/2165415/req/84886503',
    raw: {},
  };
  const a1Baseline = state.upsertA1Workitem(a1Workitem, now);
  assert.equal(a1Baseline.isNew, true);
  assert.deepEqual(a1Baseline.changedFields, []);
  const a1Unchanged = state.upsertA1Workitem(a1Workitem, '2026-07-29T14:00:01.000Z');
  assert.equal(a1Unchanged.isNew, false);
  assert.deepEqual(a1Unchanged.changedFields, []);
  const a1Changed = state.upsertA1Workitem({
    ...a1Workitem,
    status: '开发中',
    updatedAt: '2026-08-03 10:01:00',
  }, '2026-07-29T14:00:02.000Z');
  assert.deepEqual(a1Changed.changedFields, ['status']);
  assert.equal(a1Changed.before.status, '待处理');
  assert.equal(state.getA1Workitem('84886503').status, '开发中');

  state.subscribeA1Workitem('84886503', 'dingtalk:chat-1', 'dingtalk:user-1', now);
  state.subscribeA1Workitem('84886503', 'dingtalk:chat-1', 'dingtalk:user-1', now);
  assert.deepEqual(state.a1SubscribedWorkitemIds(), ['84886503']);
  assert.deepEqual(state.a1WorkitemSubscribers('84886503'), [{
    chatId: 'dingtalk:chat-1',
    senderId: 'dingtalk:user-1',
  }]);
  state.unsubscribeA1Workitem('84886503', 'dingtalk:chat-1', 'dingtalk:user-1');
  assert.deepEqual(state.a1WorkitemSubscribers('84886503'), []);

  state.subscribeA1Project('2165415', 'dingtalk:chat-2', 'dingtalk:user-2', now);
  state.subscribeA1Project('2165415', 'dingtalk:chat-2', 'dingtalk:user-2', now);
  assert.deepEqual(state.a1ProjectSubscribers('2165415'), [{
    chatId: 'dingtalk:chat-2',
    senderId: 'dingtalk:user-2',
  }]);
  state.unsubscribeA1Project('2165415', 'dingtalk:chat-2', 'dingtalk:user-2');
  assert.deepEqual(state.a1ProjectSubscribers('2165415'), []);

  assert.equal(state.enqueueA1Notification({
    notificationKey: 'a1-sync-test',
    workitemId: '84886503',
    chatId: 'dingtalk:chat-1',
    senderId: 'dingtalk:user-1',
    content: 'A1 workitem changed',
    availableAt: now,
  }), true);
  assert.equal(state.enqueueA1Notification({
    notificationKey: 'a1-sync-test',
    workitemId: '84886503',
    chatId: 'dingtalk:chat-1',
    senderId: 'dingtalk:user-1',
    content: 'A1 workitem changed',
    availableAt: now,
  }), false);
  assert.equal(state.a1NotificationCount(), 1);
  assert.equal(state.listDueA1Notifications(now, 10)[0].notificationKey, 'a1-sync-test');
  assert.deepEqual(
    state.failA1Notification(
      'a1-sync-test',
      'permanent failure',
      '2026-07-29T14:00:01.000Z',
      1,
    ),
    { updated: true, deadLettered: true, attempts: 1 },
  );
  assert.equal(state.a1NotificationCount(), 0);
  assert.equal(state.a1NotificationDeadCount(), 1);

  state.db.prepare(`INSERT INTO inbound_message
    (message_id, source, payload, status, attempts, available_at, first_seen_at, updated_at)
    VALUES (?, 'test', ?, 'pending', 0, ?, ?, ?)`)
    .run('om_corrupt', '{not-json', now, now, now);
  const corrupt = state.listReadyInbound(now, 100).find(item => item.messageId === 'om_corrupt');
  assert.equal(corrupt.payload, null);
  assert.equal(corrupt.payloadParseError, true);

  state.seedInbound('om_ancient', 'poll', { old: true }, '2025-01-01T00:00:00.000Z');
  state.db.prepare(`UPDATE inbound_message SET status = 'dead', updated_at = ?
    WHERE message_id = ?`).run('2025-01-01T00:00:00.000Z', 'om_ancient');
  state.audit('ancient', { detail: {}, createdAt: '2025-01-01T00:00:00.000Z' });
  state.db.prepare(`INSERT INTO conversation
    (chat_id, sender_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run('old-chat', 'old-user', 'user', 'old', '2025-01-01T00:00:00.000Z');
  state.set('pending_action', 'expired', { expiresAt: 1, value: { ok: true } });
  state.beginMutationExecution(
    'old-mutation',
    'test',
    '2025-01-01T00:00:00.000Z',
  );
  state.completeMutationExecution(
    'old-mutation',
    { ok: true },
    '2025-01-01T00:00:01.000Z',
  );
  const pruned = state.prune({
    now: '2026-07-29T14:00:00.000Z',
    completedInboundRetentionMs: 30 * 86400_000,
    auditRetentionMs: 90 * 86400_000,
    conversationRetentionMs: 90 * 86400_000,
  });
  assert.equal(pruned.inbound >= 1, true);
  assert.equal(pruned.audit >= 1, true);
  assert.equal(pruned.conversation >= 1, true);
  assert.equal(pruned.pendingAction >= 1, true);
  assert.equal(pruned.mutation >= 1, true);
  console.log('STATE_TEST_OK');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
