import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { A1Client, normalizeWorkitem } from './a1-client.mjs';

const calls = [];
let bodyFileSeen = '';
const runner = async (bin, args, options) => {
  calls.push({ bin, args, options });
  assert.equal(options.env.A1_NO_UPDATE_CHECK, '1');
  if (args.includes('--body-file')) {
    const path = args[args.indexOf('--body-file') + 1];
    assert.equal(existsSync(path), true);
    bodyFileSeen = readFileSync(path, 'utf8');
  }
  const key = args.slice(0, 5).join(' ');
  if (key === 'project workitem type list --project') {
    return { stdout: JSON.stringify([{ identifier: '9', displayName: '产品类需求' }]), stderr: '' };
  }
  if (key === 'project workitem field list --project') {
    return { stdout: JSON.stringify([{ identifier: 'assignedTo', isRequired: true }]), stderr: '' };
  }
  if (args[0] === 'project' && args[2] === 'create') {
    return { stdout: JSON.stringify({ id: '90000001' }), stderr: '' };
  }
  if (args[0] === 'project' && args[2] === 'update') {
    return { stdout: JSON.stringify({ id: args[3] }), stderr: '' };
  }
  if (args[0] === 'project' && args[2] === 'get') {
    return {
      stdout: JSON.stringify({
        id: args[3],
        title: '支持工作项回读',
        url: `https://project.aone.alibaba-inc.com/v2/project/2165415/req/${args[3]}`,
        description: bodyFileSeen,
        fields: [
          { identifier: 'status', value: '625587', displayValue: '就绪(待开发)' },
          { identifier: 'assignedTo', value: '170428', displayValue: '黑撒' },
          { identifier: 'space', value: '2165415', displayValue: 'WebAgent需求池' },
        ],
      }),
      stderr: '',
    };
  }
  if (args[0] === 'repo') return { stdout: JSON.stringify([{ path: 'src/index.ts' }]), stderr: '' };
  throw new Error(`unexpected args: ${args.join(' ')}`);
};

const client = new A1Client({ bin: '/opt/a1', runner });
const fetched = await client.getWorkitem('84886503');
assert.equal(fetched.status, '就绪(待开发)');
assert.deepEqual(calls.at(-1).args, ['project', 'workitem', 'get', '84886503', '-f', 'json']);

calls.length = 0;
const created = await client.createRequirement({
  projectId: '2165415',
  title: '支持工作项回读',
  body: '# 完整描述',
});
assert.equal(created.id, '90000001');
assert.equal(created.url, 'https://project.aone.alibaba-inc.com/v2/project/2165415/req/90000001');
assert.equal(bodyFileSeen, '# 完整描述');
assert.equal(calls.some(({ args }) => args.includes('--body-file')), true);
assert.equal(calls.some(({ args }) => args.join(' ').includes('project workitem field list --project 2165415 --type 9 -f json')), true);
assert.deepEqual(calls.at(-1).args, ['project', 'workitem', 'get', '90000001', '-f', 'json']);

calls.length = 0;
const updated = await client.updateRequirement('90000001', {
  title: '更新后的标题',
  body: '# 更新后的完整描述',
});
assert.equal(updated.id, '90000001');
assert.equal(bodyFileSeen, '# 更新后的完整描述');
assert.deepEqual(calls.at(-1).args, ['project', 'workitem', 'get', '90000001', '-f', 'json']);

calls.length = 0;
await client.searchRepository({
  repo: 'enterprise-development/ai-native-flow-platform',
  keyword: 'Requirement',
  branch: 'feature/20260606_29656382_init_project_1',
});
assert.deepEqual(calls[0].args, [
  'repo', 'search', 'Requirement', '--repo', 'enterprise-development/ai-native-flow-platform', '-f', 'json',
]);
assert.deepEqual(calls[1].args, [
  'repo', 'file', 'list', '', '--repo', 'enterprise-development/ai-native-flow-platform',
  '--ref', 'feature/20260606_29656382_init_project_1', '--type', 'RECURSIVE', '-f', 'json',
]);

assert.throws(() => normalizeWorkitem({ id: '1', fields: [] }), /url/);
await assert.rejects(
  () => client.createRequirement({ projectId: '999999', title: 'x', body: 'y' }),
  /not allowed/,
);

console.log('a1-client tests passed');
