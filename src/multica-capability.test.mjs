import assert from 'node:assert/strict';
import { MulticaCapability } from './multica-capability.mjs';

const subscriptions = [];
const globalSubscriptions = [];
const cached = [];
const state = {
  subscribeMulticaIssue: (issueId, chatId, senderId) => {
    subscriptions.push({ issueId, chatId, senderId });
  },
  unsubscribeMulticaIssue: () => {},
  subscribeMulticaGlobal: (chatId, senderId) => {
    globalSubscriptions.push({ chatId, senderId });
  },
  unsubscribeMulticaGlobal: () => {},
  upsertMulticaIssue: issue => cached.push(issue),
};
const baseIssue = {
  id: 'issue-1',
  workspace_id: 'ws-1',
  workspace_name: 'My Space',
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

const capability = new MulticaCapability({ client, state });
const context = { chatId: 'chat-1', senderId: 'user-1' };

const getResult = await capability.execute({
  action: 'get',
  issue: 'MYS-1',
  confirmationLevel: 'none',
}, context);
assert.equal(getResult.kind, 'reply');
assert.match(getResult.text, /MYS-1/);
assert.match(getResult.text, /待处理/);
assert.deepEqual(subscriptions[0], {
  issueId: 'issue-1',
  chatId: 'chat-1',
  senderId: 'user-1',
});

const searchResult = await capability.execute({
  action: 'search',
  query: 'growth',
  workspaceId: '',
  confirmationLevel: 'none',
}, context);
assert.match(searchResult.text, /WS-15/);

const syncResult = await capability.execute({
  action: 'sync_here',
  confirmationLevel: 'none',
}, context);
assert.match(syncResult.text, /同步/);
assert.deepEqual(globalSubscriptions[0], context);

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
assert.equal(cached.some(item => item.identifier === 'MYS-2'), true);
assert.equal(subscriptions.some(item => item.issueId === 'issue-new'), true);

const updatePreview = await capability.prepareMutation({
  summary: 'Start issue',
  action: 'update',
  issue: 'MYS-1',
  confirmationLevel: 'single',
  fields: { status: 'in_progress' },
}, context);
assert.equal(updatePreview.pending.expectedUpdatedAt, '2026-07-30T10:00:00Z');
const updateResult = await capability.applyMutation(updatePreview.pending, context);
assert.match(updateResult.text, /进行中/);

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
