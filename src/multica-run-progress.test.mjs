import assert from 'node:assert/strict';
import {
  desiredIssueStatusForRunState,
  looksLikeMulticaProgressRequest,
  summarizeMulticaRuns,
} from './multica-run-progress.mjs';

const issue = {
  id: 'issue-8',
  identifier: 'MYS-8',
  title: '黄山大会报名提升方案',
  workspace_id: 'ws-1',
  status: 'todo',
};

assert.equal(looksLikeMulticaProgressRequest('目前这个任务是不是在干活了吗？开始干了什么进度啊？'), true);
assert.equal(looksLikeMulticaProgressRequest('这个 Issue 执行到哪里了'), true);
assert.equal(looksLikeMulticaProgressRequest('帮我创建一个 Issue'), false);

const completed = summarizeMulticaRuns(issue, [
  {
    id: 'run-leader',
    status: 'COMPLETED',
    created_at: '2026-08-05T16:17:57.000Z',
    completed_at: '2026-08-05T16:19:16.000Z',
    result: { output: '负责人已接单并委派需求管理数字人。' },
  },
  {
    id: 'run-specialist',
    status: 'COMPLETED',
    created_at: '2026-08-05T16:19:01.000Z',
    completed_at: '2026-08-05T16:22:00.000Z',
    result: {
      output: '已交付可执行报名提升方案，包含8折策略、渠道话术、20席目标拆解、倒排节奏及风险与待确认项。',
    },
  },
], { appUrl: 'http://127.0.0.1:3000' });
assert.equal(completed.state, 'completed');
assert.equal(completed.runCount, 2);
assert.match(completed.text, /MYS-8/);
assert.match(completed.text, /两次专家执行均已完成/);
assert.match(completed.text, /8折策略/);
assert.match(completed.text, /Issue 本身仍是“待处理”/);
assert.ok(completed.fingerprint.length >= 16);

const running = summarizeMulticaRuns(issue, [{
  id: 'run-running',
  status: 'RUNNING',
  created_at: '2026-08-05T17:00:00.000Z',
}], {});
assert.equal(running.state, 'running');
assert.match(running.text, /正在执行/);

const none = summarizeMulticaRuns(issue, [], {});
assert.equal(none.state, 'not_started');
assert.match(none.text, /还没有运行记录/);

assert.equal(desiredIssueStatusForRunState('running', 'todo'), 'in_progress');
assert.equal(desiredIssueStatusForRunState('completed', 'in_progress'), 'done');
assert.equal(desiredIssueStatusForRunState('completed', 'todo'), 'done');
assert.equal(desiredIssueStatusForRunState('failed', 'in_progress'), 'blocked');
assert.equal(desiredIssueStatusForRunState('completed', 'done'), '');
assert.equal(desiredIssueStatusForRunState('not_started', 'todo'), '');

console.log('MULTICA_RUN_PROGRESS_TEST_OK');
