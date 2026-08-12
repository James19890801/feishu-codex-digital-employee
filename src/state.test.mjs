import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AgentState } from './state.mjs';
import { semanticTopic } from './semantic-repeat-guard.mjs';

const dir = mkdtempSync(join(tmpdir(), 'xiaozhao-state-'));
try {
  const legacyPath = join(dir, 'legacy.sqlite');
  const legacyDb = new DatabaseSync(legacyPath);
  legacyDb.exec(`
    CREATE TABLE a1_workitem_cache (
      workitem_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
      snapshot TEXT NOT NULL, workitem_updated_at TEXT NOT NULL, seen_at TEXT NOT NULL
    );
    CREATE TABLE a1_workitem_subscription (
      workitem_id TEXT NOT NULL, chat_id TEXT NOT NULL, sender_id TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY(workitem_id, chat_id, sender_id)
    );
    CREATE TABLE a1_notification_outbox (
      notification_key TEXT PRIMARY KEY, workitem_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      sender_id TEXT NOT NULL, content TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending', available_at TEXT NOT NULL,
      last_error TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      dead_at TEXT NOT NULL DEFAULT ''
    );
  `);
  legacyDb.close();
  const migrated = new AgentState(legacyPath);
  migrated.registerA1Subscription({
    workitemId: '90000002', projectId: '2165415', chatId: 'chat', senderId: 'sender',
    chatType: 'p2p', snapshot: { id: '90000002', title: '迁移测试', status: '待处理', updatedAt: 'now' },
  });
  assert.equal(migrated.a1Subscribers('90000002')[0].chatType, 'p2p');
  assert.equal(migrated.getA1WorkitemSnapshot('90000002').title, '迁移测试');
  migrated.close();

  const identityMigrationPath = join(dir, 'identity-migration.sqlite');
  const identityMigrationState = new AgentState(identityMigrationPath);
  identityMigrationState.seedInbound('legacy-outbound-message', 'outbound-send', {
    message: { chat_id: 'dingtalk:user:peer' },
  }, '2026-07-29T13:00:00.000Z');
  identityMigrationState.close();
  const identityMigrated = new AgentState(identityMigrationPath);
  assert.equal(identityMigrated.hasOutboundMessageId('legacy-outbound-message'), true);
  identityMigrated.close();

  const state = new AgentState(join(dir, 'state.sqlite'));
  assert.equal(state.db.prepare('PRAGMA synchronous').get().synchronous, 2);
  state.remember('chat', 'user', 'user', '第一条');
  state.remember('chat', 'user', 'assistant', '第二条');
  assert.deepEqual(state.history('chat', 'user').map(x => x.content), ['第一条', '第二条']);
  state.set('chat', 'paused', true);
  assert.equal(state.get('chat', 'paused'), true);
  state.audit('test', { chatId: 'chat', detail: { ok: true } });

  const now = '2026-07-29T14:00:00.000Z';
  assert.equal(state.nextInboundAvailableAt(), null);
  assert.equal(state.enqueueInbound('om_1', 'poll', { hello: 'world' }, now), true);
  assert.equal(state.nextInboundAvailableAt(), now);
  assert.equal(state.hasInbound('om_1'), true);
  assert.equal(state.hasInbound('om_missing'), false);
  assert.equal(state.enqueueInbound('om_1', 'websocket', { ignored: true }, now), false);
  assert.equal(state.claimInbound('om_1', now), true);
  assert.equal(state.claimInbound('om_1', now), false);
  state.failInbound('om_1', 'temporary failure', '2026-07-29T14:00:01.000Z');
  assert.equal(state.nextInboundAvailableAt(), '2026-07-29T14:00:01.000Z');
  assert.equal(state.claimInbound('om_1', '2026-07-29T14:00:00.500Z'), false);
  assert.equal(state.claimInbound('om_1', '2026-07-29T14:00:01.000Z'), true);
  state.completeInbound('om_1', '2026-07-29T14:00:02.000Z');
  assert.equal(state.nextInboundAvailableAt(), null);
  assert.equal(state.claimInbound('om_1', '2026-07-29T14:05:00.000Z'), false);
  assert.equal(state.latestCompletedInboundMessageId(), 'om_1');

  assert.equal(state.enqueueInbound('om_deferred', 'poll', { delayed: true }, now), true);
  assert.equal(state.claimInbound('om_deferred', now), true);
  state.deferInbound('om_deferred', '2026-07-29T14:05:00.000Z', 'owner cooldown');
  assert.equal(state.getInbound('om_deferred').status, 'pending');
  assert.equal(state.getInbound('om_deferred').attempts, 0);
  assert.equal(state.claimInbound('om_deferred', '2026-07-29T14:04:59.000Z'), false);
  assert.equal(state.claimInbound('om_deferred', '2026-07-29T14:05:00.000Z'), true);
  state.completeInbound('om_deferred', '2026-07-29T14:05:01.000Z');

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

  const semanticBase = {
    channel: 'dingtalk',
    chatId: 'dingtalk:group:semantic',
    senderId: 'dingtalk:peer',
    topic: semanticTopic('等本人确认后再推进'),
    windowMs: 60_000,
    maxReplies: 2,
  };
  assert.equal(state.claimSemanticRepeat({
    ...semanticBase, messageId: 'semantic-1', nowMs: 1_000,
  }).action, 'process');
  assert.equal(state.claimSemanticRepeat({
    ...semanticBase, messageId: 'semantic-2', nowMs: 2_000,
  }).action, 'close');
  assert.equal(state.claimSemanticRepeat({
    ...semanticBase, messageId: 'semantic-3', nowMs: 3_000,
  }).action, 'suppress');
  assert.equal(state.claimSemanticRepeat({
    ...semanticBase, messageId: 'semantic-3', nowMs: 3_100,
  }).reason, 'same_inbound_retry');
  assert.equal(state.claimSemanticRepeat({
    ...semanticBase,
    senderId: 'dingtalk:other-peer',
    messageId: 'semantic-other-sender',
    nowMs: 3_200,
  }).action, 'process');
  assert.equal(state.claimSemanticRepeat({
    ...semanticBase,
    chatId: 'dingtalk:group:other',
    messageId: 'semantic-other-chat',
    nowMs: 3_300,
  }).action, 'process');
  const changedSignal = state.claimSemanticRepeat({
    ...semanticBase,
    topic: semanticTopic('MYS-12 已完成，等本人确认后推进'),
    messageId: 'semantic-new-signal',
    nowMs: 4_000,
  });
  assert.equal(changedSignal.action, 'process');
  assert.equal(changedSignal.reset, true);
  const expiredTopic = state.claimSemanticRepeat({
    ...semanticBase,
    messageId: 'semantic-expired',
    nowMs: 65_001,
  });
  assert.equal(expiredTopic.action, 'process');
  assert.equal(expiredTopic.reason, 'expired');
  assert.deepEqual(state.semanticRepeatStats(65_001), {
    activeTopics: 1,
    totalSuppressed: 1,
    latestSuppression: null,
  });

  const outboundClaim = state.claimOutboundReply({
    chatId: 'dingtalk:group:outbound',
    audienceKey: 'dingtalk:requester',
    content: '基于资料回复这个结论',
    nowMs: 70_000,
    windowMs: 60_000,
  });
  assert.equal(outboundClaim.allowed, true);
  assert.equal(state.claimOutboundReply({
    chatId: 'dingtalk:group:outbound',
    audienceKey: 'dingtalk:requester',
    content: '基于资料回复这个结论！',
    nowMs: 71_000,
    windowMs: 60_000,
  }).allowed, false);
  assert.equal(state.claimOutboundReply({
    chatId: 'dingtalk:group:outbound',
    audienceKey: 'dingtalk:other',
    content: '基于资料回复这个结论',
    nowMs: 72_000,
    windowMs: 60_000,
  }).allowed, true);
  assert.equal(state.releaseOutboundReplyClaim(outboundClaim.claimId), true);
  assert.equal(state.claimOutboundReply({
    chatId: 'dingtalk:group:outbound',
    audienceKey: 'dingtalk:requester',
    content: '基于资料回复这个结论',
    nowMs: 73_000,
    windowMs: 60_000,
  }).allowed, true);

  state.markSelfChat('oc_self');
  assert.equal(state.isSelfChat('oc_self'), true);
  assert.equal(state.isSelfChat('oc_normal'), false);
  const guardOptions = { windowMs: 60_000, limit: 3, cooldownMs: 120_000 };
  assert.equal(state.claimSelfChatOutbound('oc_self', 1_000, guardOptions).allowed, true);
  assert.equal(state.claimSelfChatOutbound('oc_self', 2_000, guardOptions).allowed, true);
  assert.equal(state.claimSelfChatOutbound('oc_self', 3_000, guardOptions).allowed, true);
  const tripped = state.claimSelfChatOutbound('oc_self', 4_000, guardOptions);
  assert.equal(tripped.allowed, false);
  assert.equal(tripped.tripped, true);
  assert.equal(tripped.openUntilMs, 124_000);
  assert.equal(
    state.claimSelfChatOutbound('oc_self', 60_001, guardOptions).allowed,
    false,
    'an open circuit must stay silent even after the rate window changes',
  );
  assert.equal(state.claimSelfChatOutbound('oc_self', 124_001, guardOptions).allowed, true);
  assert.equal(state.claimSelfChatOutbound('oc_other_self', 4_000, guardOptions).allowed, true);

  const echoId = state.recordOutboundEcho('oc_self', '平台回复', {
    now,
    ttlMs: 120_000,
  });
  assert.equal(Number.isInteger(echoId), true);
  assert.equal(state.consumeOutboundEcho('oc_self', '别的问题', {
    now: '2026-07-29T14:00:01.000Z',
  }), false);
  assert.equal(state.consumeOutboundEcho('oc_self', '平台回复', {
    now: '2026-07-29T14:00:01.000Z',
  }), true);
  assert.equal(state.consumeOutboundEcho('oc_self', '平台回复', {
    now: '2026-07-29T14:00:02.000Z',
  }), false);

  state.recordOutboundEcho(
    'dingtalk:user:whitespace-normalized',
    '第一行\n第二行\n\n第三行',
    { now, ttlMs: 120_000 },
  );
  assert.equal(state.hasOutboundEcho(
    'dingtalk:user:whitespace-normalized',
    '第一行 第二行  第三行',
    { now: '2026-07-29T14:00:01.000Z' },
  ), true, 'DingTalk history whitespace rewriting must not hide an automated outbound echo');

  const messageEchoId = state.recordOutboundEcho('dingtalk:user:self', '钉钉回复', {
    now,
    ttlMs: 120_000,
  });
  state.attachOutboundMessageId(messageEchoId, 'dingtalk-message-1');
  assert.equal(state.hasOutboundEcho('dingtalk:user:self', '内容可能被平台重写', {
    messageId: 'dingtalk-message-1',
    now: '2026-07-29T14:00:01.000Z',
  }), true);
  assert.equal(state.consumeOutboundEcho('dingtalk:user:self', '内容可能被平台重写', {
    messageId: 'dingtalk-message-1',
    now: '2026-07-29T14:00:01.000Z',
  }), true);
  assert.equal(state.hasOutboundEcho('dingtalk:user:self', '钉钉回复', {
    messageId: 'dingtalk-message-1',
    now: '2026-07-29T14:00:02.000Z',
  }), false);
  assert.equal(state.hasOutboundMessageId('dingtalk-message-1'), true);
  assert.equal(state.hasOutboundMessageId('not-outbound'), false);

  const cancelledEchoId = state.recordOutboundEcho('oc_self', '发送失败', { now });
  assert.equal(state.cancelOutboundEcho(cancelledEchoId), true);
  assert.equal(state.consumeOutboundEcho('oc_self', '发送失败', {
    now: '2026-07-29T14:00:01.000Z',
  }), false);

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

  state.subscribeMulticaIssue(issue.id, 'chat-1', 'user-1', {
    chatType: 'group',
    createdAt: now,
  });
  state.subscribeMulticaIssue(issue.id, 'chat-1', 'user-1', {
    chatType: 'group',
    createdAt: now,
  });
  assert.deepEqual(state.multicaIssueSubscribers(issue.id), [{
    chatId: 'chat-1',
    senderId: 'user-1',
    chatType: 'group',
  }]);
  state.unsubscribeMulticaIssue(issue.id, 'chat-1', 'user-1');
  assert.deepEqual(state.multicaIssueSubscribers(issue.id), []);

  state.subscribeMulticaGlobal('chat-2', 'user-2', now);
  state.subscribeMulticaGlobal('chat-2', 'user-2', now);
  assert.deepEqual(state.multicaGlobalSubscribers(), [{
    chatId: 'chat-2',
    senderId: 'user-2',
    chatType: '',
  }]);
  state.unsubscribeMulticaGlobal('chat-2', 'user-2');
  assert.deepEqual(state.multicaGlobalSubscribers(), []);

  assert.equal(state.bindMulticaFeedbackRegistration({
    registrationKey: 'feedback-key-1',
    issue,
    createdAt: now,
  }), true);
  assert.equal(state.bindMulticaFeedbackRegistration({
    registrationKey: 'feedback-key-1',
    issue: { ...issue, id: 'issue-duplicate', identifier: 'MYS-999' },
    createdAt: now,
  }), false);
  assert.deepEqual(state.getMulticaFeedbackRegistration('feedback-key-1'), {
    registrationKey: 'feedback-key-1',
    issue,
    createdAt: now,
    updatedAt: now,
  });

  assert.equal(state.enqueueMulticaDispatch({
    issueId: issue.id,
    workspaceId: issue.workspace_id,
    assignee: '詹老师的开发团伙',
    availableAt: now,
  }), true);
  assert.equal(state.enqueueMulticaDispatch({
    issueId: issue.id,
    workspaceId: issue.workspace_id,
    assignee: '另一个 Squad',
    availableAt: now,
  }), false);
  assert.deepEqual(state.listDueMulticaDispatches(now, 10)[0], {
    issueId: issue.id,
    workspaceId: issue.workspace_id,
    assignee: '詹老师的开发团伙',
    attempts: 0,
    availableAt: now,
    lastError: '',
  });
  assert.deepEqual(state.failMulticaDispatch(
    issue.id,
    'temporary dispatch failure',
    '2026-07-29T14:00:05.000Z',
    2,
  ), { updated: true, deadLettered: false, attempts: 1 });
  assert.equal(state.multicaDispatchPendingCount(), 1);
  assert.equal(state.listDueMulticaDispatches(now, 10).length, 0);
  assert.deepEqual(state.failMulticaDispatch(
    issue.id,
    'permanent dispatch failure',
    '2026-07-29T14:00:06.000Z',
    2,
  ), { updated: true, deadLettered: true, attempts: 2 });
  assert.equal(state.multicaDispatchPendingCount(), 0);
  assert.equal(state.multicaDispatchDeadCount(), 1);

  assert.equal(state.enqueueMulticaDispatch({
    issueId: 'issue-2',
    workspaceId: 'ws-1',
    assignee: '詹老师的开发团伙',
    availableAt: now,
  }), true);
  assert.equal(state.completeMulticaDispatch('issue-2'), true);
  assert.equal(state.multicaDispatchPendingCount(), 0);
  assert.equal(state.getMulticaDispatch('issue-2').status, 'completed');

  assert.equal(state.enqueueMulticaNotification({
    notificationKey: 'multica-sync-test',
    issueId: issue.id,
    chatId: 'chat-1',
    senderId: 'user-1',
    chatType: 'group',
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
  assert.deepEqual(
    state.listDueMulticaNotifications(now, 10)[0],
    {
      notificationKey: 'multica-sync-test',
      issueId: issue.id,
      chatId: 'chat-1',
      senderId: 'user-1',
      chatType: 'group',
      content: 'Issue changed',
      attempts: 0,
      availableAt: now,
      lastError: '',
    },
  );
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

  state.registerA1Subscription({
    workitemId: '90000001',
    projectId: '2165415',
    chatId: 'dingtalk:user:requester',
    senderId: 'dingtalk:requester',
    chatType: 'p2p',
    snapshot: { id: '90000001', status: '待处理', title: '支付流程', url: 'https://project.aone/90000001' },
  });
  assert.deepEqual(state.a1WorkitemIds(), ['90000001']);
  assert.deepEqual(state.a1Subscribers('90000001'), [{
    chatId: 'dingtalk:user:requester', senderId: 'dingtalk:requester', chatType: 'p2p',
  }]);
  assert.equal(state.getA1WorkitemSnapshot('90000001').status, '待处理');
  state.cacheA1Workitem({ id: '90000001', status: '开发中', title: '支付流程', url: 'https://project.aone/90000001' });
  assert.equal(state.getA1WorkitemSnapshot('90000001').status, '开发中');
  assert.equal(state.enqueueA1Notification({
    notificationKey: 'a1:90000001:status:dev',
    workitemId: '90000001',
    chatId: 'dingtalk:user:requester',
    senderId: 'dingtalk:requester',
    chatType: 'p2p',
    content: '状态已变更',
    availableAt: now,
  }), true);
  assert.equal(state.listDueA1Notifications(now, 10).length, 1);
  assert.equal(state.completeA1Notification('a1:90000001:status:dev'), true);
  assert.equal(state.a1NotificationCount(), 0);

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
  assert.equal(pruned.semanticRepeat >= 1, true);
  assert.equal(pruned.outboundReply >= 1, true);
  console.log('STATE_TEST_OK');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
