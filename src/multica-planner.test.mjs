import assert from 'node:assert/strict';
import {
  buildMulticaPlannerPrompt,
  looksLikeMulticaRequest,
  normalizeMulticaPlan,
  parseMulticaPlannerOutput,
} from './multica-planner.mjs';

const context = {
  defaultWorkspaceId: 'ws-1',
  workspaces: [
    { id: 'ws-1', name: 'My Space', slug: 'my-space' },
    { id: 'ws-2', name: 'Huangshan', slug: 'huangshan' },
  ],
};

const query = normalizeMulticaPlan({
  summary: 'Query one issue',
  answer: 'I will look it up.',
  action: 'get',
  issue: 'WS-15',
}, context);
assert.equal(query.action, 'get');
assert.equal(query.confirmationLevel, 'none');
assert.equal(query.issue, 'WS-15');

const create = normalizeMulticaPlan({
  summary: 'Create a launch task',
  action: 'create',
  workspaceId: 'ws-2',
  fields: {
    title: 'Prepare commercial launch',
    description: 'Build the launch checklist.',
    status: 'todo',
    priority: 'high',
  },
}, context);
assert.equal(create.workspaceId, 'ws-2');
assert.equal(create.confirmationLevel, 'single');
assert.equal(create.fields.priority, 'high');

const createWithTemplatePlaceholders = normalizeMulticaPlan({
  summary: 'Create from a planner template',
  action: 'create',
  workspaceId: 'ws-1',
  fields: {
    title: 'Research human-AI organization design',
    description: '',
    status: '',
    priority: '',
    assignee: '',
    assigneeId: '',
    project: '',
    parent: '',
    dueDate: '',
    startDate: '',
  },
}, context);
assert.deepEqual(createWithTemplatePlaceholders.fields, {
  title: 'Research human-AI organization design',
  status: 'todo',
  priority: 'none',
});

const update = normalizeMulticaPlan({
  summary: 'Block the issue',
  action: 'update',
  issue: 'MYS-2',
  fields: {
    status: 'blocked',
    priority: 'urgent',
  },
}, context);
assert.equal(update.confirmationLevel, 'single');
assert.deepEqual(update.fields, { status: 'blocked', priority: 'urgent' });

const updateWithTemplatePlaceholders = normalizeMulticaPlan({
  summary: 'Rename without placeholder mutations',
  action: 'update',
  issue: 'MYS-2',
  fields: {
    title: 'Renamed issue',
    status: '',
    priority: '',
    assignee: '',
    project: '',
    dueDate: '',
  },
}, context);
assert.deepEqual(updateWithTemplatePlaceholders.fields, { title: 'Renamed issue' });

const cancel = normalizeMulticaPlan({
  summary: 'Cancel the issue',
  action: 'update',
  issue: 'MYS-2',
  fields: { status: 'cancelled' },
}, context);
assert.equal(cancel.confirmationLevel, 'double');

const comment = normalizeMulticaPlan({
  summary: 'Add a follow-up',
  action: 'comment',
  issue: 'MYS-2',
  content: 'Waiting for the customer response.',
}, context);
assert.equal(comment.confirmationLevel, 'single');

const follow = normalizeMulticaPlan({
  summary: 'Follow issue updates',
  action: 'follow',
  issue: 'MYS-2',
}, context);
assert.equal(follow.confirmationLevel, 'none');

assert.throws(
  () => normalizeMulticaPlan({
    summary: 'Delete everything',
    action: 'delete',
    issue: 'MYS-2',
  }, context),
  /not allowed/i,
);
assert.throws(
  () => normalizeMulticaPlan({
    summary: 'Write a secret',
    action: 'comment',
    issue: 'MYS-2',
    content: 'sk-abcdefghijklmnopqrstuvwxyz123456',
  }, context),
  /credential/i,
);
assert.throws(
  () => normalizeMulticaPlan({
    summary: 'Unknown workspace',
    action: 'create',
    workspaceId: 'ws-secret',
    fields: { title: 'Bad target' },
  }, context),
  /workspace/i,
);
assert.throws(
  () => normalizeMulticaPlan({
    summary: 'Unsafe field',
    action: 'update',
    issue: 'MYS-2',
    fields: { workspace_id: 'ws-2' },
  }, context),
  /field/i,
);

assert.deepEqual(
  parseMulticaPlannerOutput('```json\n{"summary":"Read","action":"get","issue":"MYS-2"}\n```'),
  { summary: 'Read', action: 'get', issue: 'MYS-2' },
);

const prompt = buildMulticaPlannerPrompt({
  request: '在黄山空间创建一个发布任务',
  history: '对方：你好',
  ...context,
});
assert.match(prompt, /JSON only/i);
assert.match(prompt, /ws-2/);
assert.match(prompt, /Huangshan/);
assert.match(prompt, /在黄山空间创建一个发布任务/);
assert.doesNotMatch(prompt, /mul_[A-Za-z0-9]+/);

assert.equal(looksLikeMulticaRequest('帮我查一下MYS-2'), true);
assert.equal(looksLikeMulticaRequest('在 Multica 创建一个 issue'), true);
assert.equal(looksLikeMulticaRequest('帮我总结一下今天的普通任务'), false);

console.log('MULTICA_PLANNER_TEST_OK');
