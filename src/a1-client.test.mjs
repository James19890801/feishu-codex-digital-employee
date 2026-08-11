import assert from 'node:assert/strict';
import { A1Client, isTransientA1Error } from './a1-client.mjs';

const listFixture = [{
  identifier: '84886503',
  spaceIdentifier: '2165415',
  subject: '需求',
  status: 'New',
  assignedTo: '阿充',
  creator: '阿充',
  categoryIdentifier: 'Req',
  workitemType: '产品类需求',
  gmtModified: '2026-08-03T10:00:00+08:00',
}];
const detailFixture = {
  id: '84886503',
  title: '需求',
  description: '需求正文',
  createdAt: '2026-08-01 09:00:00',
  updatedAt: '2026-08-03 10:00:00',
  url: 'https://project.aone.alibaba-inc.com/project/2165415/req/84886503',
  creator: {
    empId: '384351',
    nickName: '阿充',
    displayName: '阿充',
    realName: '冯周充',
  },
  review: null,
  fields: [
    {
      identifier: 'workitemType',
      label: '工作项类型(workitemType)',
      value: '9',
      displayValue: '产品类需求',
      format: 'list',
      className: 'workitemType',
      isRequired: true,
      sourceType: 'basic',
    },
    {
      identifier: 'status',
      label: '状态(status)',
      value: '100005',
      displayValue: '待处理',
      format: 'list',
      className: 'status',
      isRequired: true,
      sourceType: 'system',
    },
    {
      identifier: 'assignedTo',
      label: '指派给(assignedTo)',
      value: '384351',
      displayValue: '阿充',
      format: 'list',
      className: 'user',
      isRequired: true,
      sourceType: 'system',
    },
    {
      identifier: 'space',
      label: '归属项目(space)',
      value: '2165415',
      displayValue: 'WebAgent需求池',
      format: 'list',
      className: 'space',
      isRequired: true,
      sourceType: 'system',
    },
  ],
};

const calls = [];
const runner = async (bin, args, options) => {
  calls.push({ bin, args, options });
  if (args.includes('whoami')) {
    return { stdout: JSON.stringify({ empId: '384351', name: '阿充' }), stderr: '' };
  }
  if (args[0] === 'project' && args[1] === 'list') {
    return {
      stdout: JSON.stringify([{ id: '2165415', name: 'WebAgent需求池', status: 'ACTIVE', type: 'project' }]),
      stderr: '',
    };
  }
  if (args.includes('activity')) {
    return { stdout: JSON.stringify([{ id: 'change-1', action: 'status' }]), stderr: '' };
  }
  if (args.includes('list')) return { stdout: JSON.stringify(listFixture), stderr: '' };
  if (args.includes('get')) return { stdout: JSON.stringify(detailFixture), stderr: '' };
  if (args.includes('create') || args.includes('update')) {
    return { stdout: JSON.stringify({ id: '84886503' }), stderr: '' };
  }
  throw new Error(`unexpected A1 command: ${args.join(' ')}`);
};

const client = new A1Client({
  bin: '/opt/a1',
  defaultProjectId: '2165415',
  runner,
  pageSize: 25,
  maxWorkitems: 100,
});

assert.deepEqual(await client.whoami(), { empId: '384351', name: '阿充' });
assert.equal((await client.listProjects('WebAgent'))[0].id, '2165415');

const listed = await client.listWorkitems({ scope: 'personal', category: 'req,bug,task' });
assert.deepEqual(listed, [{
  id: '84886503',
  projectId: '2165415',
  projectName: '',
  title: '需求',
  status: 'New',
  assignee: '阿充',
  category: 'Req',
  type: '产品类需求',
  updatedAt: '2026-08-03T10:00:00+08:00',
  url: '',
  raw: listFixture[0],
}]);
const listCall = calls.find(call => call.args.includes('list') && call.args.includes('workitem'));
assert.equal(listCall.bin, '/opt/a1');
assert.ok(listCall.args.includes('--no-update-check'));
assert.deepEqual(listCall.args.slice(-2), ['-f', 'json']);
assert.equal(listCall.options.env.A1_NO_UPDATE_CHECK, '1');
assert.equal(listCall.options.timeoutMs, 30_000);
assert.equal(listCall.options.maxStdoutBytes, 8 * 1024 * 1024);

const detail = await client.getWorkitem('84886503');
assert.equal(detail.projectId, '2165415');
assert.equal(detail.projectName, 'WebAgent需求池');
assert.equal(detail.status, '待处理');
assert.equal(detail.assignee, '阿充');
assert.equal(detail.type, '产品类需求');
assert.equal(detail.description, '需求正文');

assert.deepEqual(await client.getActivity('84886503', 10), [{ id: 'change-1', action: 'status' }]);

const created = await client.createWorkitem({
  projectId: '2165415',
  category: 'req',
  title: '新增需求',
  body: '需求正文',
  assignee: '阿充',
  sprint: '26-08-04',
});
assert.equal(created.id, '84886503');
const createCall = calls.find(call => call.args.includes('workitem') && call.args.includes('create'));
assert.deepEqual(createCall.args.slice(0, 8), [
  'project', 'workitem', 'create', '--project', '2165415', '--category', 'req', '--title',
]);
assert.ok(createCall.args.includes('--body'));
assert.ok(createCall.args.includes('--assignee'));
assert.ok(createCall.args.includes('--sprint'));
assert.equal(calls.filter(call => call.args.includes('get')).length >= 2, true);

await client.updateWorkitem('84886503', { status: '开发中', title: '新标题' });
const updateCall = calls.find(call => call.args.includes('update'));
assert.ok(updateCall.args.includes('--status'));
assert.ok(updateCall.args.includes('--title'));

await client.createComment('84886503', '请评审');
const commentCall = calls.find(call => call.args.includes('comment'));
assert.deepEqual(commentCall.args.slice(0, 6), [
  'project', 'workitem', 'comment', 'create', '84886503', '-m',
]);

assert.throws(() => new A1Client({ bin: 'a1\nrm' }), /binary/i);
await assert.rejects(() => client.getWorkitem('../../etc/passwd'), /workitem ID/i);
await assert.rejects(
  () => client.createWorkitem({ projectId: '', category: 'req', title: 'No project' }),
  /project/i,
);
await assert.rejects(
  () => client.updateWorkitem('84886503', {}),
  /changes/i,
);

assert.equal(isTransientA1Error(Object.assign(new Error('timeout'), { code: 'PROCESS_TIMEOUT' })), true);
assert.equal(isTransientA1Error(Object.assign(new Error('forbidden'), { stderr: 'HTTP 403' })), false);

let writeAttempts = 0;
const atMostOnceClient = new A1Client({
  bin: '/opt/a1',
  defaultProjectId: '2165415',
  retries: 3,
  retryDelay: async () => {},
  runner: async () => {
    writeAttempts += 1;
    throw Object.assign(new Error('timeout after request may have reached A1'), {
      code: 'PROCESS_TIMEOUT',
    });
  },
});
await assert.rejects(
  () => atMostOnceClient.createWorkitem({ category: 'req', title: 'Do not duplicate' }),
  /failed/i,
);
assert.equal(writeAttempts, 1);

console.log('A1_CLIENT_TEST_OK');
