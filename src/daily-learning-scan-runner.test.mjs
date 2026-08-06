import assert from 'node:assert/strict';
import { runLearningFileScan } from './daily-learning-scan-runner.mjs';

let invocation;
const files = await runLearningFileScan({
  roots: ['/tmp/work', '/tmp/Documents'],
  sinceMs: 123,
  runner: async (command, args, options) => {
    invocation = { command, args, options };
    return { stdout: JSON.stringify([{ path: '~/plan.md', excerpt: 'safe' }]), stderr: '' };
  },
});
assert.deepEqual(files, [{ path: '~/plan.md', modifiedAt: '', excerpt: 'safe' }]);
assert.equal(invocation.command, process.execPath);
assert.match(invocation.args.at(-1), /daily-learning-scan-worker\.mjs$/);
assert.deepEqual(JSON.parse(invocation.options.input).roots, ['/tmp/work', '/tmp/Documents']);
assert.equal(invocation.options.timeoutMs, 30_000);

await assert.rejects(
  runLearningFileScan({ roots: ['/tmp'], runner: async () => ({ stdout: 'not-json' }) }),
  /invalid JSON/,
);
await assert.rejects(
  runLearningFileScan({
    roots: ['/tmp'],
    runner: async () => {
      const error = new Error('process timed out after 30000ms');
      error.stderr = 'SCANNING /Users/example/Documents/cloud-folder\n';
      throw error;
    },
  }),
  /SCANNING ~\/Documents\/cloud-folder/,
);

console.log('DAILY_LEARNING_SCAN_RUNNER_TEST_OK');
