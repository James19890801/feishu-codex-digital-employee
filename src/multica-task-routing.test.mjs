import assert from 'node:assert/strict';
import {
  applyCreateRoute,
  buildSquadQuestion,
  buildWorkspaceQuestion,
  parseSquadSelection,
  parseWorkspaceSelection,
  resolveContextualWorkRequest,
} from './multica-task-routing.mjs';

const workspaces = [
  { id: 'ws-1', name: '人机协程空间', slug: 'my-space' },
  { id: 'ws-2', name: '公开课项目', slug: 'course' },
];
const squads = [
  { id: 'squad-1', name: '詹老师的开发团伙', member_count: 4 },
  { id: 'squad-2', name: '公开课增长小队', member_count: 3 },
];

assert.match(buildWorkspaceQuestion(workspaces, 'ws-2'), /1\. 人机协程空间/);
assert.match(buildWorkspaceQuestion(workspaces, 'ws-2'), /2\. 公开课项目.*建议/s);
assert.equal(parseWorkspaceSelection('2', workspaces).id, 'ws-2');
assert.equal(parseWorkspaceSelection('人机协程空间', workspaces).id, 'ws-1');
assert.equal(parseWorkspaceSelection('不存在的空间', workspaces), null);

assert.match(buildSquadQuestion(workspaces[0], squads), /0\. 仅创建 Issue，不启动小队/);
assert.match(buildSquadQuestion(workspaces[0], squads), /1\. 詹老师的开发团伙（4 人）/);
assert.deepEqual(parseSquadSelection('0', squads), { mode: 'create_only', squad: null });
assert.deepEqual(parseSquadSelection('仅创建', squads), { mode: 'create_only', squad: null });
assert.equal(parseSquadSelection('2', squads).squad.id, 'squad-2');
assert.equal(parseSquadSelection('公开课增长小队', squads).squad.id, 'squad-2');
assert.equal(parseSquadSelection('不存在的小队', squads), null);

const createPlan = {
  action: 'create',
  workspaceId: 'ws-default',
  confirmationLevel: 'single',
  fields: { title: '报名提升', description: '当前 20 人，目标 40 人', status: 'todo' },
};
assert.deepEqual(applyCreateRoute(createPlan, {
  workspace: workspaces[0],
  selection: { mode: 'squad', squad: squads[1] },
}), {
  action: 'create',
  workspaceId: 'ws-1',
  confirmationLevel: 'double',
  fields: {
    title: '报名提升', description: '当前 20 人，目标 40 人', status: 'todo',
    assigneeId: 'squad-2',
  },
});
assert.deepEqual(applyCreateRoute({
  ...createPlan,
  fields: { ...createPlan.fields, assignee: '错误的旧值' },
}, {
  workspace: workspaces[1],
  selection: { mode: 'create_only', squad: null },
}), {
  action: 'create',
  workspaceId: 'ws-2',
  confirmationLevel: 'single',
  fields: { title: '报名提升', description: '当前 20 人，目标 40 人', status: 'todo' },
});

const issue = {
  id: 'issue-8', identifier: 'MYS-8',
  title: '制定北京公开课报名人数提升策略',
  description: '当前 20 人，目标 40 人，课程价格 3000 元/天。',
};
assert.deepEqual(resolveContextualWorkRequest('你直接安排那个专家团去执行', issue), {
  issue: 'MYS-8',
  task: '制定北京公开课报名人数提升策略\n\n当前 20 人，目标 40 人，课程价格 3000 元/天。',
});
assert.deepEqual(resolveContextualWorkRequest('继续执行那个任务，最后给我 PDF', issue), {
  issue: 'MYS-8',
  task: '制定北京公开课报名人数提升策略\n\n当前 20 人，目标 40 人，课程价格 3000 元/天。\n\n本轮补充要求：继续执行那个任务，最后给我 PDF',
});
assert.equal(resolveContextualWorkRequest('今天天气怎么样', issue), null);
assert.equal(resolveContextualWorkRequest('去执行', null), null);

console.log('MULTICA_TASK_ROUTING_TEST_OK');
