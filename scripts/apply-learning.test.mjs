import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentState } from '../src/state.mjs';

const directory = await mkdtemp(join(tmpdir(), 'aipro-apply-learning-cli-'));
const statePath = join(directory, 'agent-state.sqlite');

try {
  const payload = {
    learningDate: '2026-08-09',
    summary: '完成一项真实改进。',
    acceptedChanges: [{
      category: 'closure',
      problem: '任务答复没有闭环。',
      action: '任务答复明确结果和下一步。',
      verification: '检查下一日同类任务是否减少重复追问。',
    }],
    memoryRules: ['任务答复明确结果和下一步。'],
  };
  const result = spawnSync(process.execPath, [
    'scripts/apply-learning.mjs', '--state', statePath,
  ], {
    cwd: new URL('..', import.meta.url),
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    applied: true,
    learningDate: '2026-08-09',
    acceptedCount: 1,
    ruleCount: 1,
    memoryUpdated: true,
  });

  const state = new AgentState(statePath);
  try {
    assert.match(state.get('learning', 'memory', ''), /任务答复明确结果和下一步/);
  } finally {
    state.close();
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log('APPLY_LEARNING_CLI_TEST_OK');
