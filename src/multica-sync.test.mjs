import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentState } from './state.mjs';
import {
  MulticaSynchronizer,
  formatMulticaChange,
} from './multica-sync.mjs';

const dir = mkdtempSync(join(tmpdir(), 'aipro-multica-sync-'));
try {
  const state = new AgentState(join(dir, 'state.sqlite'));
  const issue1 = {
    id: 'issue-1',
    workspace_id: 'ws-1',
    workspace_name: 'My Space',
    workspace_slug: 'my-space',
    identifier: 'MYS-1',
    title: 'Commercial launch',
    description: 'Prepare the launch.',
    status: 'todo',
    priority: 'high',
    assignee_id: null,
    due_date: null,
    updated_at: '2026-07-30T10:00:00Z',
  };
  let issues = [issue1];
  const notices = [];
  const audits = [];
  let failChat = '';
  const synchronizer = new MulticaSynchronizer({
    client: { listAllIssues: async () => structuredClone(issues) },
    state,
    ownerRecipient: {
      chatId: 'dingtalk:user:owner-open-id',
      senderId: 'dingtalk:owner-open-id',
      chatType: 'p2p',
      channel: 'dingtalk',
    },
    notify: async (chatId, text, idempotencyKey, recipient) => {
      if (chatId === failChat) throw new Error('temporary Feishu failure');
      notices.push({ chatId, text, idempotencyKey, recipient });
    },
    audit: (event, detail) => audits.push({ event, detail }),
  });

  const baseline = await synchronizer.cycle();
  assert.deepEqual(baseline, { baseline: true, scanned: 1, notified: 0, changes: 0 });
  assert.equal(notices.length, 0);

  state.subscribeMulticaGlobal('chat-global', 'owner', { channel: 'feishu' });
  state.subscribeMulticaIssue('issue-1', 'chat-issue', 'user', {
    chatType: 'group',
    channel: 'feishu',
  });
  state.subscribeMulticaIssue('issue-1', 'chat-global', 'another-user', {
    channel: 'feishu',
  });
  state.bindMulticaIssueOrigin('issue-1', {
    chatId: 'chat-issue',
    senderId: 'user',
    chatType: 'group',
    channel: 'feishu',
  });
  issues = [{
    ...issue1,
    status: 'in_progress',
    updated_at: '2026-07-30T10:01:00Z',
  }];
  const changed = await synchronizer.cycle();
  assert.equal(changed.baseline, false);
  assert.equal(changed.changes, 1);
  assert.equal(changed.notified, 2);
  assert.deepEqual(notices.map(item => item.chatId).sort(), [
    'chat-global',
    'chat-issue',
  ]);
  assert.match(notices[0].text, /MYS-1/);
  assert.match(notices[0].text, /待处理 → 进行中/);
  assert.match(notices[0].text, /https:\/\/multica\.ai\/my-space\/issues\/MYS-1/);
  assert.deepEqual(
    notices.find(item => item.chatId === 'chat-issue').recipient,
    { senderId: 'user', chatType: 'group' },
  );
  assert.equal(notices.some(item => item.chatId === 'dingtalk:user:owner-open-id'), false);

  notices.length = 0;
  const unchanged = await synchronizer.cycle();
  assert.equal(unchanged.changes, 0);
  assert.equal(unchanged.notified, 0);

  issues = [{
    ...issues[0],
    priority: 'urgent',
    updated_at: '2026-07-30T10:01:30Z',
  }];
  failChat = 'chat-issue';
  const partiallyDelivered = await synchronizer.cycle();
  assert.equal(partiallyDelivered.changes, 1);
  assert.equal(partiallyDelivered.notified, 1);
  assert.equal(partiallyDelivered.failed, 1);
  assert.equal(partiallyDelivered.pending, 1);
  failChat = '';
  const retried = await synchronizer.cycle({
    now: new Date(Date.now() + 10 * 60_000),
  });
  assert.equal(retried.changes, 0);
  assert.equal(retried.notified, 1);
  assert.equal(retried.pending, 0);
  assert.equal(notices.at(-1).chatId, 'chat-issue');

  state.enqueueMulticaNotification({
    notificationKey: 'temporarily-suppressed-notification',
    issueId: 'issue-1',
    chatId: 'dingtalk:user:owner-open-id',
    content: 'Retry after the self-chat circuit closes',
    availableAt: new Date().toISOString(),
  });
  const suppressedSynchronizer = new MulticaSynchronizer({
    client: { listAllIssues: async () => structuredClone(issues) },
    state,
    notify: async () => ({ suppressed: true, reason: 'self_chat_circuit_open' }),
  });
  const suppressedDelivery = await suppressedSynchronizer.deliverNotifications(new Date());
  assert.equal(suppressedDelivery.notified, 0);
  assert.equal(suppressedDelivery.failed, 1);
  assert.equal(suppressedDelivery.pending, 1);
  state.completeMulticaNotification('temporarily-suppressed-notification');

  notices.length = 0;
  issues = [
    ...issues,
    {
      id: 'issue-2',
      workspace_id: 'ws-1',
      workspace_name: 'My Space',
      workspace_slug: 'my-space',
      identifier: 'MYS-2',
      title: 'New external issue',
      description: [
        '来源渠道：钉钉',
        '来源发送者：陈菲',
        '原始需求：修复自动回复偶发中断。',
        '补充说明：影响客户测试，需要确保秒级回复。',
      ].join('\n'),
      creator_id: 'member-creator-1',
      creator_type: 'member',
      status: 'todo',
      priority: 'none',
      assignee_id: null,
      due_date: null,
      updated_at: '2026-07-30T10:02:00Z',
    },
  ];
  const created = await synchronizer.cycle();
  assert.equal(created.changes, 1);
  assert.equal(created.notified, 1);
  assert.deepEqual(notices.map(item => item.chatId).sort(), [
    'dingtalk:user:owner-open-id',
  ]);
  const ownerNotice = notices.find(item => item.chatId === 'dingtalk:user:owner-open-id');
  assert.match(ownerNotice.text, /新 Issue/);
  assert.match(ownerNotice.text, /做什么：修复自动回复偶发中断/);
  assert.match(ownerNotice.text, /为什么：影响客户测试，需要确保秒级回复/);
  assert.match(ownerNotice.text, /谁提出：陈菲/);
  assert.match(ownerNotice.text, /来源：钉钉/);
  assert.match(ownerNotice.text, /https:\/\/multica\.ai\/my-space\/issues\/MYS-2/);
  assert.equal(audits.some(item => item.event === 'multica_sync_change'), true);

  state.enqueueMulticaNotification({
    notificationKey: 'dead-notification',
    issueId: 'issue-1',
    chatId: 'chat-dead',
    content: 'Will fail permanently',
    availableAt: new Date().toISOString(),
  });
  failChat = 'chat-dead';
  const deadSynchronizer = new MulticaSynchronizer({
    client: { listAllIssues: async () => structuredClone(issues) },
    state,
    notify: async () => {
      throw new Error('permanent Feishu failure');
    },
    audit: (event, detail) => audits.push({ event, detail }),
    maxNotificationAttempts: 1,
  });
  const deadDelivery = await deadSynchronizer.deliverNotifications(new Date());
  assert.equal(deadDelivery.dead, 1);
  assert.equal(deadDelivery.pending, 0);
  assert.equal(state.multicaNotificationDeadCount(), 1);
  assert.equal(
    audits.some(item => item.event === 'multica_sync_notification_dead_lettered'),
    true,
  );

  assert.equal(
    formatMulticaChange({
      isNew: false,
      changedFields: ['priority'],
      before: { identifier: 'MYS-1', title: 'A', priority: 'high' },
      after: { identifier: 'MYS-1', title: 'A', priority: 'urgent', workspace_name: 'My Space' },
    }).includes('高 → 紧急'),
    true,
  );

  console.log('MULTICA_SYNC_TEST_OK');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
