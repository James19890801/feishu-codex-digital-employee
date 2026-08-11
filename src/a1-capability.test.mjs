import assert from 'node:assert/strict';
import { A1Capability } from './a1-capability.mjs';

const subscriptions = [];
const projectSubscriptions = [];
const cached = [];
const state = {
  subscribeA1Workitem: (workitemId, chatId, senderId) => {
    subscriptions.push({ workitemId, chatId, senderId });
  },
  unsubscribeA1Workitem: () => {},
  subscribeA1Project: (projectId, chatId, senderId) => {
    projectSubscriptions.push({ projectId, chatId, senderId });
  },
  unsubscribeA1Project: () => {},
  upsertA1Workitem: workitem => cached.push(workitem),
};
const baseWorkitem = {
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
let liveWorkitem = structuredClone(baseWorkitem);
const client = {
  listProjects: async () => [
    { id: '2165415', name: 'WebAgent需求池', status: 'ACTIVE', type: 'project' },
  ],
  listWorkitems: async () => [structuredClone(liveWorkitem)],
  getWorkitem: async id => {
    if (id === liveWorkitem.id) return structuredClone(liveWorkitem);
    throw new Error('not found');
  },
  getActivity: async () => [{ id: 'change-1', action: 'status', operator: '阿充' }],
  createWorkitem: async fields => ({
    ...baseWorkitem,
    ...fields,
    id: '84900001',
    projectId: fields.projectId,
    updatedAt: '2026-08-03 11:00:00',
  }),
  updateWorkitem: async (id, fields) => {
    liveWorkitem = {
      ...liveWorkitem,
      ...fields,
      updatedAt: '2026-08-03 11:01:00',
    };
    return structuredClone(liveWorkitem);
  },
  createComment: async () => ({
    ...liveWorkitem,
    updatedAt: '2026-08-03 11:02:00',
  }),
};

const capability = new A1Capability({ client, state, defaultProjectId: '2165415' });
const context = { chatId: 'dingtalk:conversation-1', senderId: 'dingtalk:user-1' };

const getResult = await capability.execute({
  action: 'get',
  workitemId: '84886503',
  confirmationLevel: 'none',
}, context);
assert.equal(getResult.kind, 'reply');
assert.match(getResult.text, /84886503/);
assert.match(getResult.text, /待处理/);
assert.deepEqual(subscriptions[0], {
  workitemId: '84886503',
  chatId: 'dingtalk:conversation-1',
  senderId: 'dingtalk:user-1',
});

const listResult = await capability.execute({
  action: 'list',
  projectId: '2165415',
  filters: { category: 'req' },
  confirmationLevel: 'none',
}, context);
assert.match(listResult.text, /84886503/);

const activityResult = await capability.execute({
  action: 'activity',
  workitemId: '84886503',
  confirmationLevel: 'none',
}, context);
assert.match(activityResult.text, /change-1/);

const syncResult = await capability.execute({
  action: 'sync_here',
  projectId: '2165415',
  confirmationLevel: 'none',
}, context);
assert.match(syncResult.text, /同步/);
assert.deepEqual(projectSubscriptions[0], {
  projectId: '2165415',
  chatId: 'dingtalk:conversation-1',
  senderId: 'dingtalk:user-1',
});

await assert.rejects(
  () => capability.execute({
    action: 'update',
    workitemId: '84886503',
    confirmationLevel: 'single',
    fields: { status: '开发中' },
  }, context),
  /prepared and confirmed/i,
);

const createPreview = await capability.prepareMutation({
  summary: '创建需求',
  action: 'create',
  projectId: '2165415',
  confirmationLevel: 'single',
  fields: { category: 'req', title: '新增需求', body: '正文' },
}, context);
assert.equal(createPreview.kind, 'confirmation');
assert.match(createPreview.text, /WebAgent需求池/);
assert.match(createPreview.text, /新增需求/);

await assert.rejects(
  () => capability.applyMutation(createPreview.pending, {
    chatId: context.chatId,
    senderId: 'dingtalk:another-user',
  }),
  /context does not match/i,
);
const createResult = await capability.applyMutation(createPreview.pending, context);
assert.match(createResult.text, /84900001/);
assert.equal(cached.some(item => item.id === '84900001'), true);

const updatePreview = await capability.prepareMutation({
  summary: '开始开发',
  action: 'update',
  workitemId: '84886503',
  confirmationLevel: 'single',
  fields: { status: '开发中' },
}, context);
assert.equal(updatePreview.pending.expectedUpdatedAt, '2026-08-03 10:00:00');
const updateResult = await capability.applyMutation(updatePreview.pending, context);
assert.match(updateResult.text, /开发中/);

liveWorkitem = { ...liveWorkitem, updatedAt: '2026-08-03 12:00:00' };
const stalePreview = await capability.prepareMutation({
  summary: '改标题',
  action: 'update',
  workitemId: '84886503',
  confirmationLevel: 'single',
  fields: { title: '新标题' },
}, context);
liveWorkitem = { ...liveWorkitem, updatedAt: '2026-08-03 12:01:00' };
await assert.rejects(
  () => capability.applyMutation(stalePreview.pending, context),
  /changed after the preview/i,
);

console.log('A1_CAPABILITY_TEST_OK');
