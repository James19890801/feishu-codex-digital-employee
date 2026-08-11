import assert from 'node:assert/strict';
import {
  buildA1PlannerPrompt,
  looksLikeA1Request,
  normalizeA1Plan,
  parseA1PlannerOutput,
} from './a1-planner.mjs';

const context = {
  defaultProjectId: '2165415',
  projects: [
    { id: '2165415', name: 'WebAgent需求池', status: 'ACTIVE', type: 'project' },
    { id: '2171393', name: '协同空间升级', status: 'ACTIVE', type: 'project' },
  ],
};

const get = normalizeA1Plan({
  summary: '读取工作项',
  action: 'get',
  workitemId: '84886503',
}, context);
assert.equal(get.action, 'get');
assert.equal(get.confirmationLevel, 'none');
assert.equal(get.workitemId, '84886503');

const list = normalizeA1Plan({
  summary: '查看需求池',
  action: 'list',
  projectId: 'WebAgent需求池',
  filters: { category: 'req', status: '待处理', title: 'Agent' },
}, context);
assert.equal(list.projectId, '2165415');
assert.deepEqual(list.filters, { category: 'req', status: '待处理', title: 'Agent' });

const create = normalizeA1Plan({
  summary: '创建需求',
  action: 'create',
  fields: {
    category: 'req',
    title: '支持 A1 数字员工',
    body: '接入 A1 工作项。',
    sprint: '26-08-04',
  },
}, context);
assert.equal(create.projectId, '2165415');
assert.equal(create.confirmationLevel, 'single');
assert.equal(create.fields.category, 'req');

const update = normalizeA1Plan({
  summary: '更新负责人',
  action: 'update',
  workitemId: '84886503',
  fields: { assignee: '阿充' },
}, context);
assert.equal(update.confirmationLevel, 'double');

const cancel = normalizeA1Plan({
  summary: '取消需求',
  action: 'update',
  workitemId: '84886503',
  fields: { status: '已取消' },
}, context);
assert.equal(cancel.confirmationLevel, 'double');

const comment = normalizeA1Plan({
  summary: '添加评论',
  action: 'comment',
  workitemId: '84886503',
  content: '请产品评审。',
}, context);
assert.equal(comment.confirmationLevel, 'single');

assert.throws(
  () => normalizeA1Plan({ summary: '删除', action: 'delete', workitemId: '84886503' }, context),
  /not allowed/i,
);
assert.throws(
  () => normalizeA1Plan({
    summary: '写凭证',
    action: 'comment',
    workitemId: '84886503',
    content: 'access_token=abcdefghijklmnopqrstuvwxyz',
  }, context),
  /credential/i,
);
assert.throws(
  () => normalizeA1Plan({
    summary: '未知项目',
    action: 'create',
    projectId: '9999999',
    fields: { category: 'req', title: '错误目标' },
  }, context),
  /project/i,
);
assert.throws(
  () => normalizeA1Plan({
    summary: '危险字段',
    action: 'update',
    workitemId: '84886503',
    fields: { token: 'secret' },
  }, context),
  /field/i,
);
assert.throws(
  () => normalizeA1Plan({
    summary: '同步别的项目',
    action: 'sync_here',
    projectId: '2171393',
  }, context),
  /configured project/i,
);
assert.throws(
  () => normalizeA1Plan({
    summary: '任意文件',
    action: 'create',
    fields: { category: 'req', title: '附件', attachment: '/etc/passwd' },
  }, context),
  /field/i,
);

assert.deepEqual(
  parseA1PlannerOutput('```json\n{"summary":"读取","action":"get","workitemId":"84886503"}\n```'),
  { summary: '读取', action: 'get', workitemId: '84886503' },
);

const prompt = buildA1PlannerPrompt({
  request: '在 WebAgent需求池 创建一个需求',
  history: '用户：刚刚说的是 A1',
  ...context,
});
assert.match(prompt, /JSON only/i);
assert.match(prompt, /2165415/);
assert.match(prompt, /WebAgent需求池/);
assert.match(prompt, /DingTalk/i);
assert.doesNotMatch(prompt, /access_token=/i);

assert.equal(looksLikeA1Request('帮我查 A1 工作项 84886503'), true);
assert.equal(looksLikeA1Request('用1A创建一个研发需求'), true);
assert.equal(looksLikeA1Request('帮我更新这个工作项状态'), true);
assert.equal(looksLikeA1Request('帮我总结一下今天的普通任务'), false);

console.log('A1_PLANNER_TEST_OK');
