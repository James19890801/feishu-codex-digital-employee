import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentState } from './state.mjs';
import { semanticTopic } from './semantic-repeat-guard.mjs';

const dir = mkdtempSync(join(tmpdir(), 'xiaozhao-state-'));
try {
  const state = new AgentState(join(dir, 'state.sqlite'));
  assert.equal(state.db.prepare('PRAGMA synchronous').get().synchronous, 2);
  state.remember('chat', 'user', 'user', '第一条');
  state.remember('chat', 'user', 'assistant', '第二条');
  assert.deepEqual(state.history('chat', 'user').map(x => x.content), ['第一条', '第二条']);
  for (let index = 3; index <= 35; index += 1) {
    state.remember('chat', 'user', index % 2 ? 'user' : 'assistant', `第${index}条`);
  }
  assert.equal(state.history('chat', 'user').length, 30, '每轮默认应取最近 30 条会话');
  assert.equal(state.history('chat', 'user')[0].content, '第6条');
  state.remember('chat', 'user', 'user', '只记一次', { sourceMessageId: 'message-once' });
  state.remember('chat', 'user', 'user', '只记一次', { sourceMessageId: 'message-once' });
  assert.equal(
    state.history('chat', 'user', 120).filter(item => item.content === '只记一次').length,
    1,
    '轮询和 WebSocket 重复投递不能重复写入记忆',
  );
  state.remember('group-chat', 'member-a', 'user', 'AI 将流程管理推向事中干预', {
    sourceMessageId: 'group-a-1', createdAt: '2026-08-08T12:00:00.000Z',
  });
  state.remember('group-chat', 'member-b', 'user', '我认为价值重心会从画流程转向解释判断', {
    sourceMessageId: 'group-b-1', createdAt: '2026-08-08T12:00:01.000Z',
  });
  assert.deepEqual(
    state.chatHistory('group-chat', 30).map(item => [item.senderId, item.content]),
    [
      ['member-a', 'AI 将流程管理推向事中干预'],
      ['member-b', '我认为价值重心会从画流程转向解释判断'],
    ],
    '群聊上下文必须包含所有参与者的最近消息',
  );
  state.bindConversationIssue('chat', 'user', {
    id: 'issue-active',
    identifier: 'MYS-8',
    title: '制定北京公开课报名人数提升策略',
    description: '当前 20 人，目标 40 人。',
    workspace_id: 'ws-1',
  });
  assert.deepEqual(state.conversationIssue('chat', 'user'), {
    id: 'issue-active',
    identifier: 'MYS-8',
    title: '制定北京公开课报名人数提升策略',
    description: '当前 20 人，目标 40 人。',
    workspace_id: 'ws-1',
  });
  state.set('chat', 'paused', true);
  assert.equal(state.get('chat', 'paused'), true);
  state.audit('test', { chatId: 'chat', detail: { ok: true } });

  state.remember('learning-chat', 'learning-user', 'user', '修复消息重复问题', {
    createdAt: '2026-08-06T14:00:00.000Z',
  });
  state.audit('poller_error', {
    detail: { error: 'too many request' },
    createdAt: '2026-08-06T14:01:00.000Z',
  });
  const learningEvidence = state.learningEvidence(
    '2026-08-06T00:00:00.000Z',
    '2026-08-07T00:00:00.000Z',
  );
  assert.equal(learningEvidence.conversations.some(item => item.content === '修复消息重复问题'), true);
  assert.equal(learningEvidence.audits.some(item => item.event === 'poller_error'), true);
  state.startLearningRun({
    id: 'learning-2026-08-07',
    learningDate: '2026-08-07',
    startedAt: '2026-08-06T17:00:00.000Z',
    sourceFromAt: '2026-08-05T17:00:00.000Z',
    sourceToAt: '2026-08-06T17:00:00.000Z',
  });
  state.completeLearningRun('learning-2026-08-07', {
    completedAt: '2026-08-06T17:01:00.000Z',
    summary: '完成每日复盘',
    memory: '回复前先读上下文',
    filesScanned: 8,
    chatsReviewed: 12,
    tasksLearned: 2,
    skillsLearned: 3,
    errorsLearned: 4,
    items: [{ category: 'error', title: '轮询限流', lesson: '合并重复搜索' }],
  });
  const learningStatus = state.learningStatus();
  assert.equal(learningStatus.totalRuns, 1);
  assert.equal(learningStatus.lastRun.status, 'completed');
  assert.equal(learningStatus.lastRun.errorsLearned, 4);
  assert.equal(learningStatus.recentRuns[0].items[0].title, '轮询限流');
  assert.equal(state.get('learning', 'memory'), '回复前先读上下文');

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

  const semanticOptions = {
    channel: 'dingtalk',
    chatId: 'dingtalk:group:test',
    senderId: 'dingtalk:other-bot',
    windowMs: 30 * 60_000,
    maxReplies: 2,
  };
  const firstSemantic = state.claimSemanticRepeat({
    ...semanticOptions,
    topic: semanticTopic('等杨红宝确认后再推进'),
    nowMs: 1_000,
  });
  assert.deepEqual(
    { action: firstSemantic.action, count: firstSemantic.count, reset: firstSemantic.reset },
    { action: 'process', count: 1, reset: false },
  );
  const secondSemantic = state.claimSemanticRepeat({
    ...semanticOptions,
    topic: semanticTopic('这个需要等杨红宝确认后再往下推进'),
    nowMs: 2_000,
  });
  assert.equal(secondSemantic.action, 'close');
  assert.equal(secondSemantic.count, 2);
  const thirdSemantic = state.claimSemanticRepeat({
    ...semanticOptions,
    topic: semanticTopic('等杨红宝本人确认后再推进'),
    nowMs: 3_000,
  });
  assert.equal(thirdSemantic.action, 'suppress');
  assert.equal(thirdSemantic.count, 3);
  assert.equal(state.claimSemanticRepeat({
    ...semanticOptions,
    topic: semanticTopic('MYS-12 已经完成，查看新结果'),
    nowMs: 4_000,
  }).action, 'process', 'materially new information must reset the topic');
  assert.equal(state.claimSemanticRepeat({
    ...semanticOptions,
    chatId: 'dingtalk:group:other',
    topic: semanticTopic('等杨红宝确认后再推进'),
    nowMs: 5_000,
  }).action, 'process', 'different chats must be isolated');
  assert.equal(state.claimSemanticRepeat({
    ...semanticOptions,
    senderId: 'dingtalk:human',
    topic: semanticTopic('等杨红宝确认后再推进'),
    nowMs: 6_000,
  }).action, 'process', 'different senders must be isolated');
  assert.equal(state.claimSemanticRepeat({
    ...semanticOptions,
    topic: semanticTopic('等杨红宝确认后再推进'),
    nowMs: 31 * 60_000,
  }).action, 'process', 'expired topics must reset');
  const semanticStats = state.semanticRepeatStats(31 * 60_000);
  assert.equal(semanticStats.activeTopics >= 1, true);
  assert.equal(semanticStats.totalSuppressed >= 1, true);
  assert.equal('topic' in (semanticStats.latestSuppression || {}), false);

  const discussionOptions = {
    channel: 'dingtalk',
    chatId: 'dingtalk:group:debate',
    maxReplies: 100,
    lowValueLimit: 3,
    cooldownMs: 30 * 60_000,
  };
  const valuableTopic = semanticTopic('AI 会把流程管理从事后复盘推向事中干预。');
  const firstDiscussion = state.claimDiscussionTurn({
    ...discussionOptions,
    messageId: 'discussion-1',
    value: { substantive: true, score: 4, topic: valuableTopic },
    nowMs: 10_000,
  });
  assert.deepEqual(
    { action: firstDiscussion.action, replyCount: firstDiscussion.replyCount, sessionNo: firstDiscussion.sessionNo },
    { action: 'process', replyCount: 1, sessionNo: 1 },
  );
  assert.equal(state.claimDiscussionTurn({
    ...discussionOptions,
    messageId: 'discussion-1',
    value: { substantive: true, score: 4, topic: valuableTopic },
    nowMs: 10_001,
  }).reason, 'same_inbound_retry', 'the same inbound retry must not consume another reply');

  for (let replyCount = 2; replyCount <= 19; replyCount += 1) {
    state.claimDiscussionTurn({
      ...discussionOptions,
      messageId: `discussion-${replyCount}`,
      value: {
        substantive: true,
        score: 3,
        topic: semanticTopic(`第 ${replyCount} 轮补充了不同的流程治理证据。`),
      },
      nowMs: 10_000 + replyCount,
    });
  }
  const checkpoint = state.claimDiscussionTurn({
    ...discussionOptions,
    messageId: 'discussion-20',
    value: { substantive: true, score: 3, topic: semanticTopic('第 20 轮形成阶段结论。') },
    nowMs: 10_020,
  });
  assert.equal(checkpoint.action, 'checkpoint');
  assert.equal(checkpoint.replyCount, 20);

  for (let replyCount = 21; replyCount <= 99; replyCount += 1) {
    state.claimDiscussionTurn({
      ...discussionOptions,
      messageId: `discussion-${replyCount}`,
      value: {
        substantive: true,
        score: 3,
        topic: semanticTopic(`第 ${replyCount} 轮出现了新的观点。`),
      },
      nowMs: 10_000 + replyCount,
    });
  }
  const finalDiscussion = state.claimDiscussionTurn({
    ...discussionOptions,
    messageId: 'discussion-100',
    value: { substantive: true, score: 3, topic: semanticTopic('第 100 轮给出最终综合。') },
    nowMs: 10_100,
  });
  assert.equal(finalDiscussion.action, 'final');
  assert.equal(finalDiscussion.replyCount, 100);
  assert.equal(state.discussionSession('dingtalk', discussionOptions.chatId).status, 'finalizing');
  assert.equal(state.completeDiscussionFinalReply({
    channel: 'dingtalk', chatId: discussionOptions.chatId, nowMs: 10_101,
    cooldownMs: discussionOptions.cooldownMs,
  }), true);
  assert.equal(state.claimDiscussionTurn({
    ...discussionOptions,
    messageId: 'discussion-101',
    value: { substantive: true, score: 4, topic: valuableTopic },
    nowMs: 10_102,
  }).action, 'suppress_cooldown');
  assert.equal(state.claimDiscussionTurn({
    ...discussionOptions,
    messageId: 'discussion-owner-continue',
    value: { substantive: true, score: 4, topic: valuableTopic },
    ownerContinue: true,
    nowMs: 10_103,
  }).sessionNo, 2, 'verified owner continuation must start a fresh bounded session');

  const lowValueChat = 'dingtalk:group:low-value';
  for (let turn = 1; turn <= 2; turn += 1) {
    assert.equal(state.claimDiscussionTurn({
      ...discussionOptions,
      chatId: lowValueChat,
      messageId: `low-${turn}`,
      value: { substantive: false, score: -2, topic: semanticTopic('好的') },
      nowMs: 20_000 + turn,
    }).action, 'process');
  }
  const lowValueClosure = state.claimDiscussionTurn({
    ...discussionOptions,
    chatId: lowValueChat,
    messageId: 'low-3',
    value: { substantive: false, score: -2, topic: semanticTopic('收到') },
    nowMs: 20_003,
  });
  assert.equal(lowValueClosure.action, 'close_low_value');
  assert.equal(lowValueClosure.lowValueStreak, 3);
  assert.equal(state.claimDiscussionTurn({
    ...discussionOptions,
    chatId: lowValueChat,
    messageId: 'low-4',
    value: { substantive: false, score: -2, topic: semanticTopic('明白') },
    nowMs: 20_004,
  }).action, 'suppress_cooldown');
  const discussionStats = state.discussionStats(20_004);
  assert.equal(discussionStats.activeSessions >= 1, true);
  assert.equal(discussionStats.closedSessions >= 2, true);
  assert.equal('recentTopics' in (discussionStats.latestClosure || {}), false);

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
    channel: 'feishu',
    createdAt: now,
  });
  state.subscribeMulticaIssue(issue.id, 'chat-1', 'user-1', {
    chatType: 'group',
    channel: 'feishu',
    createdAt: now,
  });
  assert.deepEqual(state.multicaIssueSubscribers(issue.id), [{
    chatId: 'chat-1',
    senderId: 'user-1',
    chatType: 'group',
    channel: 'feishu',
  }]);
  state.unsubscribeMulticaIssue(issue.id, 'chat-1', 'user-1');
  assert.deepEqual(state.multicaIssueSubscribers(issue.id), []);

  state.subscribeMulticaGlobal('chat-2', 'user-2', {
    channel: 'dingtalk',
    createdAt: now,
  });
  state.subscribeMulticaGlobal('chat-2', 'user-2', {
    channel: 'dingtalk',
    createdAt: now,
  });
  assert.deepEqual(state.multicaGlobalSubscribers(), [{
    chatId: 'chat-2',
    senderId: 'user-2',
    chatType: '',
    channel: 'dingtalk',
  }]);
  state.unsubscribeMulticaGlobal('chat-2', 'user-2');
  assert.deepEqual(state.multicaGlobalSubscribers(), []);

  assert.equal(state.bindMulticaIssueOrigin(issue.id, {
    chatId: 'chat-origin-feishu',
    senderId: 'user-owner',
    chatType: 'p2p',
    channel: 'feishu',
    createdAt: now,
  }), true);
  assert.equal(state.bindMulticaIssueOrigin(issue.id, {
    chatId: 'dingtalk:user:owner',
    senderId: 'dingtalk:owner',
    chatType: 'p2p',
    channel: 'dingtalk',
    createdAt: now,
  }), false);
  assert.deepEqual(state.multicaIssueOrigin(issue.id), {
    issueId: issue.id,
    chatId: 'chat-origin-feishu',
    senderId: 'user-owner',
    chatType: 'p2p',
    channel: 'feishu',
    createdAt: now,
  });
  assert.deepEqual(state.trackedMulticaIssueIds(), [issue.id]);
  const runBaseline = state.upsertMulticaIssueRunSummary(issue.id, {
    state: 'queued',
    fingerprint: 'fingerprint-queued',
    runCount: 1,
    latestUpdatedAt: now,
  }, now);
  assert.equal(runBaseline.isNew, true);
  assert.equal(runBaseline.changed, false);
  const runUnchanged = state.upsertMulticaIssueRunSummary(issue.id, {
    state: 'queued',
    fingerprint: 'fingerprint-queued',
    runCount: 1,
    latestUpdatedAt: now,
  }, now);
  assert.equal(runUnchanged.changed, false);
  const runChanged = state.upsertMulticaIssueRunSummary(issue.id, {
    state: 'completed',
    fingerprint: 'fingerprint-completed',
    runCount: 2,
    latestUpdatedAt: '2026-07-29T14:05:00.000Z',
  }, '2026-07-29T14:05:00.000Z');
  assert.equal(runChanged.isNew, false);
  assert.equal(runChanged.changed, true);
  assert.equal(runChanged.before.state, 'queued');
  assert.equal(runChanged.after.state, 'completed');
  assert.equal(
    state.conversationIssue('chat-origin-feishu', 'user-owner')?.identifier,
    'MYS-1',
    'existing Issue origins must backfill active conversation context after upgrades',
  );

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

  state.upsertMulticaDeliveryContract({
    issueId: issue.id,
    workspaceId: issue.workspace_id,
    channel: 'feishu',
    chatId: 'chat-origin-feishu',
    senderId: 'user-owner',
    chatType: 'p2p',
    formats: ['pdf', 'xlsx'],
    request: '最终交付 PDF 和 Excel',
    createdAt: now,
  });
  assert.deepEqual(state.multicaDeliveryContract(issue.id), {
    issueId: issue.id,
    workspaceId: issue.workspace_id,
    channel: 'feishu',
    chatId: 'chat-origin-feishu',
    senderId: 'user-owner',
    chatType: 'p2p',
    formats: ['pdf', 'xlsx'],
    request: '最终交付 PDF 和 Excel',
    status: 'requested',
    artifactIds: [],
    attempts: 0,
    lastError: '',
    createdAt: now,
    updatedAt: now,
    deliveredAt: '',
  });
  state.updateMulticaDeliveryContract(issue.id, {
    status: 'delivered', artifactIds: ['attachment-1'], deliveredAt: now,
  }, now);
  assert.equal(state.multicaDeliveryContract(issue.id).status, 'delivered');
  assert.deepEqual(state.multicaDeliveryContract(issue.id).artifactIds, ['attachment-1']);
  assert.equal(state.multicaRunMessageCursor('run-1'), 0);
  state.advanceMulticaRunMessageCursor('run-1', issue.id, 7, now);
  assert.equal(state.multicaRunMessageCursor('run-1'), 7);
  state.advanceMulticaRunMessageCursor('run-1', issue.id, 4, now);
  assert.equal(state.multicaRunMessageCursor('run-1'), 7, 'run cursor cannot move backwards');

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
