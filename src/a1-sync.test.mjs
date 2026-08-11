import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentState } from './state.mjs';
import { A1Synchronizer, formatA1Change } from './a1-sync.mjs';

const dir = mkdtempSync(join(tmpdir(), 'aipro-a1-sync-'));
try {
  const state = new AgentState(join(dir, 'state.sqlite'));
  const workitem1 = {
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
  let projectWorkitems = [workitem1];
  const individuallyFetched = new Map();
  const listCalls = [];
  const getCalls = [];
  const notices = [];
  const audits = [];
  let failChat = '';
  const client = {
    listWorkitems: async options => {
      listCalls.push(options);
      return structuredClone(projectWorkitems);
    },
    getWorkitem: async id => {
      getCalls.push(id);
      return structuredClone(individuallyFetched.get(id));
    },
  };
  const synchronizer = new A1Synchronizer({
    client,
    state,
    defaultProjectId: '2165415',
    maxWorkitems: 100,
    notify: async (chatId, text, idempotencyKey) => {
      if (chatId === failChat) throw new Error('temporary DingTalk failure');
      notices.push({ chatId, text, idempotencyKey });
    },
    audit: (event, detail) => audits.push({ event, detail }),
  });

  const baseline = await synchronizer.cycle({ now: new Date('2026-08-03T02:00:00.000Z') });
  assert.deepEqual(baseline, {
    baseline: true,
    scanned: 1,
    notified: 0,
    failed: 0,
    dead: 0,
    pending: 0,
    changes: 0,
  });
  assert.equal(notices.length, 0);
  assert.equal(listCalls[0].projectId, '2165415');
  assert.equal(listCalls[0].scope, 'project');
  assert.equal(listCalls[0].pageSize, 100);

  state.subscribeA1Project('2165415', 'dingtalk:chat-project', 'owner');
  state.subscribeA1Workitem('84886503', 'dingtalk:chat-item', 'user');
  state.subscribeA1Workitem('84886503', 'dingtalk:chat-project', 'another-user');
  projectWorkitems = [{
    ...workitem1,
    status: '开发中',
    updatedAt: '2026-08-03 10:01:00',
  }];
  const changed = await synchronizer.cycle({ now: new Date('2026-08-03T02:01:00.000Z') });
  assert.equal(changed.baseline, false);
  assert.equal(changed.changes, 1);
  assert.equal(changed.notified, 2);
  assert.deepEqual(notices.map(item => item.chatId).sort(), [
    'dingtalk:chat-item',
    'dingtalk:chat-project',
  ]);
  assert.match(notices[0].text, /84886503/);
  assert.match(notices[0].text, /待处理 → 开发中/);

  notices.length = 0;
  const unchanged = await synchronizer.cycle({ now: new Date('2026-08-03T02:02:00.000Z') });
  assert.equal(unchanged.changes, 0);
  assert.equal(unchanged.notified, 0);

  projectWorkitems = [{
    ...projectWorkitems[0],
    title: '数字员工接入 A1（一期）',
    updatedAt: '2026-08-03 10:03:00',
  }];
  failChat = 'dingtalk:chat-item';
  const partial = await synchronizer.cycle({ now: new Date('2026-08-03T02:03:00.000Z') });
  assert.equal(partial.notified, 1);
  assert.equal(partial.failed, 1);
  assert.equal(partial.pending, 1);
  failChat = '';
  const retried = await synchronizer.cycle({ now: new Date('2026-08-03T02:13:00.000Z') });
  assert.equal(retried.changes, 0);
  assert.equal(retried.notified, 1);
  assert.equal(retried.pending, 0);

  notices.length = 0;
  projectWorkitems = [
    ...projectWorkitems,
    {
      ...workitem1,
      id: '84900001',
      title: '新需求',
      status: '待处理',
      updatedAt: '2026-08-03 10:04:00',
    },
  ];
  const created = await synchronizer.cycle({ now: new Date('2026-08-03T02:14:00.000Z') });
  assert.equal(created.changes, 1);
  assert.equal(created.notified, 1);
  assert.equal(notices[0].chatId, 'dingtalk:chat-project');
  assert.match(notices[0].text, /新工作项/);

  const external = {
    ...workitem1,
    id: '84910001',
    projectId: '2171393',
    projectName: '协同空间升级',
    title: '外部项目工作项',
  };
  state.upsertA1Workitem(external);
  state.subscribeA1Workitem(external.id, 'dingtalk:chat-external', 'user-external');
  individuallyFetched.set(external.id, {
    ...external,
    status: '已完成',
    updatedAt: '2026-08-03 10:05:00',
  });
  notices.length = 0;
  const individual = await synchronizer.cycle({ now: new Date('2026-08-03T02:15:00.000Z') });
  assert.equal(individual.changes, 1);
  assert.equal(individual.notified, 1);
  assert.equal(notices[0].chatId, 'dingtalk:chat-external');
  assert.deepEqual(getCalls, ['84910001']);

  let disabledProjectScans = 0;
  const noProjectState = new AgentState(join(dir, 'no-project.sqlite'));
  const noProjectSync = new A1Synchronizer({
    client: {
      listWorkitems: async () => { disabledProjectScans += 1; return []; },
      getWorkitem: async () => { throw new Error('must not fetch'); },
    },
    state: noProjectState,
    defaultProjectId: '',
    notify: async () => {},
  });
  const noProject = await noProjectSync.cycle();
  assert.equal(noProject.scanned, 0);
  assert.equal(disabledProjectScans, 0);
  noProjectState.close();

  state.enqueueA1Notification({
    notificationKey: 'a1-dead-notification',
    workitemId: '84886503',
    chatId: 'dingtalk:chat-dead',
    content: 'Will fail permanently',
    availableAt: new Date('2026-08-03T02:16:00.000Z').toISOString(),
  });
  const deadSynchronizer = new A1Synchronizer({
    client,
    state,
    defaultProjectId: '2165415',
    notify: async () => { throw new Error('permanent DingTalk failure'); },
    audit: (event, detail) => audits.push({ event, detail }),
    maxNotificationAttempts: 1,
  });
  const deadDelivery = await deadSynchronizer.deliverNotifications(
    new Date('2026-08-03T02:16:00.000Z'),
  );
  assert.equal(deadDelivery.dead, 1);
  assert.equal(deadDelivery.pending, 0);
  assert.equal(state.a1NotificationDeadCount(), 1);
  assert.equal(audits.some(item => item.event === 'a1_sync_notification_dead_lettered'), true);

  assert.match(formatA1Change({
    isNew: false,
    changedFields: ['status'],
    before: { id: '84886503', title: 'A', status: '待处理' },
    after: { id: '84886503', title: 'A', status: '开发中', projectName: 'WebAgent需求池' },
  }), /待处理 → 开发中/);

  console.log('A1_SYNC_TEST_OK');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
