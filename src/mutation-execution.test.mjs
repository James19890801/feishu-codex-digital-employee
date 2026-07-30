import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentState } from './state.mjs';
import {
  MutationOutcomeAmbiguousError,
  executeMutationOnce,
} from './mutation-execution.mjs';

const dir = mkdtempSync(join(tmpdir(), 'aipro-mutation-'));
try {
  const state = new AgentState(join(dir, 'state.sqlite'));
  let executions = 0;
  const first = await executeMutationOnce({
    state,
    executionKey: 'task:confirm-1',
    kind: 'feishu_task_create',
    operation: async () => {
      executions += 1;
      return { id: 'task-1', summary: 'Commercial hardening' };
    },
  });
  assert.equal(first.replayed, false);
  assert.equal(first.result.id, 'task-1');

  const replay = await executeMutationOnce({
    state,
    executionKey: 'task:confirm-1',
    kind: 'feishu_task_create',
    operation: async () => {
      executions += 1;
      return { id: 'task-duplicate' };
    },
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.result.id, 'task-1');
  assert.equal(executions, 1);

  let uncertainExecutions = 0;
  await assert.rejects(
    executeMutationOnce({
      state,
      executionKey: 'multica:create:confirm-2',
      kind: 'multica_issue_create',
      operation: async () => {
        uncertainExecutions += 1;
        throw new Error('connection closed after request was sent');
      },
    }),
    error => error instanceof MutationOutcomeAmbiguousError
      && error.code === 'MUTATION_OUTCOME_AMBIGUOUS',
  );
  assert.equal(state.getMutationExecution('multica:create:confirm-2').status, 'ambiguous');

  await assert.rejects(
    executeMutationOnce({
      state,
      executionKey: 'multica:create:confirm-2',
      kind: 'multica_issue_create',
      operation: async () => {
        uncertainExecutions += 1;
        return { id: 'issue-duplicate' };
      },
    }),
    error => error instanceof MutationOutcomeAmbiguousError,
  );
  assert.equal(uncertainExecutions, 1);

  const stale = new Error('preview is stale');
  stale.code = 'STALE_PRECONDITION';
  await assert.rejects(
    executeMutationOnce({
      state,
      executionKey: 'multica:update:confirm-3',
      kind: 'multica_issue_update',
      operation: async () => {
        throw stale;
      },
      definitelyNotApplied: error => error?.code === 'STALE_PRECONDITION',
    }),
    error => error === stale,
  );
  assert.equal(state.getMutationExecution('multica:update:confirm-3').status, 'failed_safe');
  state.close();
  console.log('MUTATION_EXECUTION_TEST_OK');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
