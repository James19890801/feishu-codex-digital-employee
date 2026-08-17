import assert from 'node:assert/strict';
import { isAuthorizedMulticaOwner } from './multica-access.mjs';
import {
  MulticaWorkLifecycle,
  parseMulticaWorkRequest,
} from './multica-work-lifecycle.mjs';

assert.deepEqual(
  parseMulticaWorkRequest('处理 MYS-9：输出一句验收结论'),
  { issue: 'MYS-9', task: '输出一句验收结论' },
);
assert.deepEqual(
  parseMulticaWorkRequest('请执行 ABC-12，整理本周风险清单'),
  { issue: 'ABC-12', task: '整理本周风险清单' },
);
assert.equal(parseMulticaWorkRequest('更新 MYS-9 的状态为完成'), null);
assert.equal(parseMulticaWorkRequest('查一下 MYS-9'), null);

function fixture(initialStatus = 'todo') {
  let issue = {
    id: 'issue-9',
    identifier: 'MYS-9',
    workspace_id: 'ws-1',
    workspace_slug: 'my-space',
    title: 'Lifecycle acceptance',
    status: initialStatus,
    priority: 'none',
    updated_at: '2026-08-01T07:00:00Z',
  };
  const updates = [];
  const subscriptions = [];
  const client = {
    getIssue: async () => structuredClone(issue),
    updateIssue: async (id, fields) => {
      updates.push({ id, fields: structuredClone(fields) });
      issue = {
        ...issue,
        ...fields,
        updated_at: `2026-08-01T07:00:0${updates.length}Z`,
      };
      return structuredClone(issue);
    },
  };
  const state = {
    subscribeMulticaIssue: (issueId, chatId, senderId, options) => {
      subscriptions.push({ issueId, chatId, senderId, options });
    },
  };
  return {
    lifecycle: new MulticaWorkLifecycle({
      client,
      state,
      authorizeWrite: candidate => isAuthorizedMulticaOwner(candidate, {
        ownerOpenId: 'ou-owner',
        enterpriseChatOwnerOpenId: 'dt-owner',
      }),
    }),
    updates,
    subscriptions,
    current: () => structuredClone(issue),
  };
}

const context = {
  chatId: 'oc-work',
  senderId: 'ou-owner',
  chatType: 'p2p',
  metadata: { channel: 'feishu', selfChat: true },
};

{
  const test = fixture();
  const binding = await test.lifecycle.begin('MYS-9', context);
  assert.equal(binding.issue.status, 'in_progress');
  assert.deepEqual(test.updates[0], {
    id: 'issue-9',
    fields: { workspaceId: 'ws-1', status: 'in_progress' },
  });
  assert.deepEqual(test.subscriptions[0], {
    issueId: 'issue-9',
    chatId: 'oc-work',
    senderId: 'ou-owner',
    options: { chatType: 'p2p', channel: 'feishu' },
  });

  const completed = await test.lifecycle.complete(binding);
  assert.equal(completed.status, 'done');
  assert.equal(test.updates.at(-1).fields.status, 'done');
}

{
  const test = fixture();
  const binding = await test.lifecycle.begin('MYS-9', context);
  const blocked = await test.lifecycle.block(binding);
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.workspace_slug, 'my-space');
  assert.equal(test.updates.at(-1).fields.status, 'blocked');
}

{
  const test = fixture('done');
  await assert.rejects(
    test.lifecycle.begin('MYS-9', context),
    /terminal status/i,
  );
  assert.equal(test.updates.length, 0);
}

{
  const test = fixture();
  await assert.rejects(
    test.lifecycle.begin('MYS-9', {
      ...context,
      chatType: 'group',
      metadata: { channel: 'feishu', selfChat: true },
    }),
    error => error?.code === 'MULTICA_OWNER_REQUIRED',
  );
  assert.equal(test.updates.length, 0);
  assert.equal(test.subscriptions.length, 0);
}

{
  const test = fixture();
  const events = [];
  const result = await test.lifecycle.run({
    reference: 'MYS-9',
    context,
    onStarted: async issue => events.push(`started:${issue.status}`),
    execute: async () => '可交付结果',
    deliver: async answer => events.push(`delivered:${answer}`),
  });
  assert.equal(result.outcome, 'completed');
  assert.equal(result.issue.status, 'done');
  assert.deepEqual(events, ['started:in_progress', 'delivered:可交付结果']);
}

{
  const test = fixture();
  const result = await test.lifecycle.run({
    reference: 'MYS-9',
    context,
    execute: async () => { throw new Error('runtime unavailable'); },
    deliver: async () => {},
  });
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.issue.status, 'blocked');
  assert.match(result.error.message, /runtime unavailable/);
}

console.log('MULTICA_WORK_LIFECYCLE_TEST_OK');
