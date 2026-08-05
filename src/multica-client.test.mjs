import assert from 'node:assert/strict';
import { MulticaClient, isTransientMulticaError } from './multica-client.mjs';

const calls = [];
const pages = new Map([
  ['ws-1:0', {
    issues: [
      { id: 'issue-1', identifier: 'MYS-1', title: 'First', workspace_id: 'ws-1' },
      { id: 'issue-2', identifier: 'MYS-2', title: 'Second', workspace_id: 'ws-1' },
    ],
    total: 3,
    has_more: true,
    limit: 2,
    offset: 0,
  }],
  ['ws-1:2', {
    issues: [
      { id: 'issue-3', identifier: 'MYS-3', title: 'Third', workspace_id: 'ws-1' },
    ],
    total: 3,
    has_more: false,
    limit: 2,
    offset: 2,
  }],
  ['ws-2:0', {
    issues: [
      { id: 'issue-4', identifier: 'WS-15', title: 'Growth plan', workspace_id: 'ws-2' },
    ],
    total: 1,
    has_more: false,
    limit: 2,
    offset: 0,
  }],
]);

const runner = async (command, args, options) => {
  calls.push({ command, args, options });
  if (args.includes('workspace') && args.includes('list')) {
    return {
      stdout: JSON.stringify([
        { id: 'ws-1', name: 'My Space', slug: 'my-space' },
        { id: 'ws-2', name: 'Huangshan', slug: 'huangshan' },
      ]),
      stderr: '',
    };
  }
  if (args.includes('squad') && args.includes('list')) {
    return {
      stdout: JSON.stringify([
        { id: 'squad-1', name: '詹老师的开发团伙', workspace_id: 'ws-1', member_count: 4 },
      ]),
      stderr: '',
    };
  }
  if (args.includes('issue') && args.includes('list')) {
    const workspaceId = args[args.indexOf('--workspace-id') + 1];
    const offset = args[args.indexOf('--offset') + 1];
    return { stdout: JSON.stringify(pages.get(`${workspaceId}:${offset}`)), stderr: '' };
  }
  if (args.includes('issue') && args.includes('create')) {
    return {
      stdout: JSON.stringify({
        id: 'new-issue',
        identifier: 'MYS-4',
        title: 'New commercial task',
        description: options.input,
        workspace_id: 'ws-1',
        status: 'todo',
      }),
      stderr: '',
    };
  }
  if (args.includes('issue') && args.includes('runs')) {
    return {
      stdout: JSON.stringify([
        {
          id: 'run-1',
          issue_id: 'issue-1',
          status: 'COMPLETED',
          created_at: '2026-08-05T16:17:57.000Z',
          completed_at: '2026-08-05T16:19:16.000Z',
          result: { output: '负责人已接单并委派需求管理数字人。' },
        },
      ]),
      stderr: '',
    };
  }
  throw new Error(`unexpected command: ${args.join(' ')}`);
};

const client = new MulticaClient({
  bin: '/opt/multica',
  profile: 'desktop-api.multica.ai',
  defaultWorkspaceId: 'ws-1',
  runner,
  pageSize: 2,
});

const workspaces = await client.listWorkspaces();
assert.deepEqual(workspaces.map(item => item.id), ['ws-1', 'ws-2']);
const squads = await client.listSquads('ws-1');
assert.deepEqual(squads, [{
  id: 'squad-1',
  name: '詹老师的开发团伙',
  workspace_id: 'ws-1',
  member_count: 4,
}]);
const squadCall = calls.find(call => call.args.includes('squad'));
assert.deepEqual(squadCall.args.slice(0, 4), [
  '--profile', 'desktop-api.multica.ai', '--workspace-id', 'ws-1',
]);

const issues = await client.listAllIssues();
assert.deepEqual(issues.map(item => item.identifier), ['MYS-1', 'MYS-2', 'MYS-3', 'WS-15']);
assert.equal(calls.filter(call => call.args.includes('list') && call.args.includes('issue')).length, 3);

const search = await client.searchIssues('growth');
assert.deepEqual(search.map(item => item.identifier), ['WS-15']);

const runs = await client.listIssueRuns('issue-1', 'ws-1');
assert.equal(runs[0].status, 'COMPLETED');
const runsCall = calls.find(call => call.args.includes('runs'));
assert.deepEqual(runsCall.args, [
  '--profile', 'desktop-api.multica.ai', '--workspace-id', 'ws-1',
  'issue', 'runs', 'issue-1', '--output', 'json',
]);

const created = await client.createIssue({
  workspaceId: 'ws-1',
  title: 'New commercial task',
  description: 'Line 1\nLine 2',
  status: 'todo',
  priority: 'high',
  assigneeId: 'squad-1',
});
assert.equal(created.identifier, 'MYS-4');
const createCall = calls.find(call => call.args.includes('create'));
assert.deepEqual(createCall.args.slice(0, 4), [
  '--profile', 'desktop-api.multica.ai', '--workspace-id', 'ws-1',
]);
assert.equal(createCall.args.includes('--description-stdin'), true);
assert.equal(createCall.args.includes('--assignee-id'), true);
assert.equal(createCall.args.includes('squad-1'), true);
assert.equal(createCall.args.includes('Line 1\nLine 2'), false);
assert.equal(createCall.options.input, 'Line 1\nLine 2');

assert.equal(isTransientMulticaError(Object.assign(new Error('timeout'), {
  code: 'PROCESS_TIMEOUT',
})), true);
assert.equal(isTransientMulticaError(Object.assign(new Error('HTTP 503'), {
  stderr: 'server returned 503',
})), true);
assert.equal(isTransientMulticaError(Object.assign(new Error('forbidden'), {
  stderr: 'HTTP 403',
})), false);

let unsafeCreateAttempts = 0;
const noDuplicateWriteClient = new MulticaClient({
  bin: '/opt/multica',
  profile: 'desktop-api.multica.ai',
  defaultWorkspaceId: 'ws-1',
  retries: 3,
  retryDelay: async () => {},
  runner: async () => {
    unsafeCreateAttempts += 1;
    throw Object.assign(new Error('timeout after request may have reached server'), {
      code: 'PROCESS_TIMEOUT',
    });
  },
});
await assert.rejects(
  () => noDuplicateWriteClient.createIssue({
    title: 'Do not duplicate me',
    status: 'todo',
    priority: 'none',
  }),
  /failed/i,
);
assert.equal(unsafeCreateAttempts, 1);

const commentCalls = [];
const commentClient = new MulticaClient({
  bin: '/opt/multica',
  profile: 'desktop-api.multica.ai',
  runner: async (command, args, options) => {
    commentCalls.push({ command, args, options });
    if (args.includes('get')) {
      return {
        stdout: JSON.stringify({
          id: 'issue-1',
          identifier: 'MYS-1',
          title: 'First',
          workspace_id: 'ws-1',
        }),
        stderr: '',
      };
    }
    return {
      stdout: JSON.stringify({ id: 'comment-1', content: options.input }),
      stderr: '',
    };
  },
});
await commentClient.addComment('MYS-1', 'Private follow-up text', 'ws-1');
const commentCall = commentCalls.find(call => call.args.includes('comment'));
assert.equal(commentCall.args.includes('--content-stdin'), true);
assert.equal(commentCall.args.includes('Private follow-up text'), false);
assert.equal(commentCall.options.input, 'Private follow-up text');

console.log('MULTICA_CLIENT_TEST_OK');
