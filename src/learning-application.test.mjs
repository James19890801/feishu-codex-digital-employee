import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentState } from './state.mjs';
import { applyAcceptedLearning } from './learning-application.mjs';

const directory = await mkdtemp(join(tmpdir(), 'aipro-learning-application-'));
const state = new AgentState(join(directory, 'agent-state.sqlite'));

try {
  state.set('learning', 'memory', '旧规则：回复前读取上下文。');

  const result = applyAcceptedLearning(state, {
    learningDate: '2026-08-09',
    summary: '接受两项改进并写入运行时记忆。',
    acceptedChanges: [
      {
        category: 'response',
        problem: '回答后没有明确下一步。',
        action: '涉及行动的回答在结尾给出一个可执行下一步。',
        verification: '观察后续追问是否减少。',
      },
      {
        category: 'tone',
        problem: '简单问题回答过长。',
        action: '简单问题优先用一至三句回答。',
        verification: '检查同类回复长度。',
      },
    ],
    memoryRules: [
      '涉及行动的回答在结尾给出一个可执行下一步。',
      '简单问题优先用一至三句回答。',
    ],
  });

  assert.equal(result.applied, true);
  assert.equal(result.acceptedCount, 2);
  assert.equal(result.ruleCount, 2);
  const memory = state.get('learning', 'memory', '');
  assert.match(memory, /旧规则：回复前读取上下文/);
  assert.match(memory, /涉及行动的回答在结尾给出一个可执行下一步/);
  assert.match(memory, /简单问题优先用一至三句回答/);
  assert.equal(state.get('learning', 'last_applied_date', ''), '2026-08-09');

  const audit = state.db.prepare(
    "SELECT detail FROM audit WHERE event = 'daily_learning_changes_applied' ORDER BY id DESC LIMIT 1",
  ).get();
  assert.ok(audit);
  assert.deepEqual(JSON.parse(audit.detail), {
    learningDate: '2026-08-09',
    acceptedCount: 2,
    ruleCount: 2,
    categories: ['response', 'tone'],
  });

  assert.throws(() => applyAcceptedLearning(state, {
    learningDate: '2026-08-10',
    summary: '只有复盘，没有实际改进。',
    acceptedChanges: [],
    memoryRules: [],
  }), /at least one accepted change/i);
} finally {
  state.close();
  await rm(directory, { recursive: true, force: true });
}

console.log('LEARNING_APPLICATION_TEST_OK');
