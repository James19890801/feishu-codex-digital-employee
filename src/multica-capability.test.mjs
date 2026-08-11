import assert from 'node:assert/strict';
import { MulticaCapability } from './multica-capability.mjs';
import { isAuthorizedMulticaOwner } from './multica-access.mjs';

const subscriptions = [];
const globalSubscriptions = [];
const cached = [];
const state = {
  subscribeMulticaIssue: (issueId, chatId, senderId, options) => {
    subscriptions.push({ issueId, chatId, senderId, options });
  },
  unsubscribeMulticaIssue: () => {},
  subscribeMulticaGlobal: (chatId, senderId, options) => {
    globalSubscriptions.push({ chatId, senderId, ...options });
  },
  unsubscribeMulticaGlobal: () => {},
  upsertMulticaIssue: issue => cached.push(issue),
};
const baseIssue = {
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
let liveIssue = structuredClone(baseIssue);
const client = {
  listWorkspaces: async () => [
    { id: 'ws-1', name: 'My Space', slug: 'my-space' },
    { id: 'ws-2', name: 'Huangshan', slug: 'huangshan' },
  ],
  listAllIssues: async ({ workspaces } = {}) => {
    const all = [liveIssue, {
      ...baseIssue,
      id: 'issue-2',
      identifier: 'WS-15',
      title: 'Growth plan',
      workspace_id: 'ws-2',
      workspace_name: 'Huangshan',
      workspace_slug: 'huangshan',
    }];
    return workspaces ? all.filter(item => workspaces.some(ws => ws.id === item.workspace_id)) : all;
  },
  searchIssues: async query => query === 'growth' ? [{
    ...baseIssue,
    id: 'issue-2',
    identifier: 'WS-15',
    title: 'Growth plan',
    workspace_id: 'ws-2',
    workspace_name: 'Huangshan',
    workspace_slug: 'huangshan',
  }] : [],
  getIssue: async reference => {
    if (['MYS-1', 'issue-1'].includes(reference)) return structuredClone(liveIssue);
    throw new Error('not found');
  },
  createIssue: async fields => ({
    ...baseIssue,
    ...fields,
    id: 'issue-new',
    identifier: 'MYS-2',
    workspace_id: fields.workspaceId,
    updated_at: '2026-07-30T11:00:00Z',
  }),
  updateIssue: async (reference, fields) => {
    liveIssue = {
      ...liveIssue,
      ...fields,
      updated_at: '2026-07-30T11:01:00Z',
    };
    return structuredClone(liveIssue);
  },
  addComment: async () => ({
    issue: structuredClone(liveIssue),
    comment: { id: 'comment-1', content: 'Following up.' },
  }),
};

const capability = new MulticaCapability({
  client,
  state,
  authorizeWrite: candidate => isAuthorizedMulticaOwner(candidate, {
    ownerOpenId: 'ou_owner',
    dingtalkOwnerOpenId: 'dt_owner',
  }),
});
const context = {
  chatId: 'chat-1',
  senderId: 'ou_owner',
  chatType: 'p2p',
  metadata: { channel: 'feishu', selfChat: true },
};

const getResult = await capability.execute({
  action: 'get',
  issue: 'MYS-1',
  confirmationLevel: 'none',
}, context);
assert.equal(getResult.kind, 'reply');
assert.match(getResult.text, /MYS-1/);
assert.match(getResult.text, /待处理/);
assert.match(getResult.text, /https:\/\/multica\.ai\/my-space\/issues\/MYS-1/);
assert.doesNotMatch(getResult.text, /Prepare the launch\./);
assert.deepEqual(subscriptions[0], {
  issueId: 'issue-1',
  chatId: 'chat-1',
  senderId: 'ou_owner',
  options: { chatType: 'p2p' },
});

const searchResult = await capability.execute({
  action: 'search',
  query: 'growth',
  workspaceId: '',
  confirmationLevel: 'none',
}, context);
assert.match(searchResult.text, /WS-15/);
assert.match(searchResult.text, /https:\/\/multica\.ai\/huangshan\/issues\/WS-15/);

const syncResult = await capability.execute({
  action: 'sync_here',
  confirmationLevel: 'none',
}, context);
assert.match(syncResult.text, /同步/);
assert.deepEqual(globalSubscriptions[0], {
  chatId: 'chat-1',
  senderId: 'ou_owner',
  chatType: 'p2p',
});

const createPreview = await capability.prepareMutation({
  summary: 'Create issue',
  action: 'create',
  workspaceId: 'ws-1',
  confirmationLevel: 'single',
  fields: {
    title: 'Launch checklist',
    description: 'Prepare launch.',
    status: 'todo',
    priority: 'high',
  },
}, context);
assert.equal(createPreview.kind, 'confirmation');
assert.match(createPreview.text, /Launch checklist/);
assert.equal(createPreview.pending.plan.action, 'create');

const createResult = await capability.applyMutation(createPreview.pending, context);
assert.match(createResult.text, /MYS-2/);
assert.match(createResult.text, /https:\/\/multica\.ai\/my-space\/issues\/MYS-2/);
assert.equal(cached.some(item => item.identifier === 'MYS-2'), true);
assert.equal(subscriptions.some(item => item.issueId === 'issue-new'), true);

const unauthorizedContext = {
  ...context,
  chatType: 'group',
  metadata: { channel: 'feishu', selfChat: true },
};

for (const unauthorizedPlan of [{
    summary: 'Unauthorized create',
    action: 'create',
    workspaceId: 'ws-1',
    confirmationLevel: 'single',
    fields: { title: 'Must not be created', status: 'todo', priority: 'none' },
  }, {
    summary: 'Unauthorized assignment',
    action: 'update',
    issue: 'MYS-1',
    confirmationLevel: 'double',
    fields: { assignee: 'Forbidden Squad' },
  }, {
    summary: 'Unauthorized comment',
    action: 'comment',
    issue: 'MYS-1',
    confirmationLevel: 'single',
    content: 'Must not be written',
  }]) {
  await assert.rejects(
    capability.prepareMutation(unauthorizedPlan, unauthorizedContext),
    error => error?.code === 'MULTICA_OWNER_REQUIRED',
  );
}

await assert.rejects(
  capability.applyMutation(createPreview.pending, {
    ...context,
    metadata: { channel: 'feishu' },
  }),
  error => error?.code === 'MULTICA_OWNER_REQUIRED',
);

const updatePreview = await capability.prepareMutation({
  summary: 'Start issue',
  action: 'update',
  issue: 'MYS-1',
  confirmationLevel: 'single',
  fields: { status: 'in_progress' },
}, context);
assert.equal(updatePreview.pending.expectedUpdatedAt, '2026-07-30T10:00:00Z');
const cachedBeforeUpdate = cached.length;
const updateResult = await capability.applyMutation(updatePreview.pending, context);
assert.match(updateResult.text, /进行中/);
assert.equal(
  cached.length,
  cachedBeforeUpdate,
  'platform updates must leave the previous cache snapshot for the synchronizer to diff',
);
assert.equal(subscriptions.at(-1).issueId, 'issue-1');

const commentPreview = await capability.prepareMutation({
  summary: 'Add follow-up',
  action: 'comment',
  issue: 'MYS-1',
  confirmationLevel: 'single',
  content: 'Following up.',
}, context);
const commentResult = await capability.applyMutation(commentPreview.pending, context);
assert.match(commentResult.text, /Following up\./);
assert.match(commentResult.text, /https:\/\/multica\.ai\/my-space\/issues\/MYS-1/);

liveIssue = { ...liveIssue, updated_at: '2026-07-30T12:00:00Z' };
const stalePreview = await capability.prepareMutation({
  summary: 'Change priority',
  action: 'update',
  issue: 'MYS-1',
  confirmationLevel: 'single',
  fields: { priority: 'urgent' },
}, context);
liveIssue = { ...liveIssue, updated_at: '2026-07-30T12:01:00Z' };
await assert.rejects(
  capability.applyMutation(stalePreview.pending, context),
  /changed after the preview/i,
);

console.log('MULTICA_CAPABILITY_TEST_OK');
