import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  consumeLinesUntilExit,
  shouldRetrySupervisor,
} from './event-consumer.mjs';

assert.equal(shouldRetrySupervisor(false), true);
assert.equal(shouldRetrySupervisor(true), false);

{
  const child = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    const descendant = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 3000)'], {
      detached: true,
      stdio: ['ignore', 'inherit', 'ignore'],
    });
    descendant.unref();
    process.stdout.write('{"message_id":"om_test"}\\n');
    setTimeout(() => process.exit(5), 20);
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  const startedAt = Date.now();
  const exitCode = await consumeLinesUntilExit(child, line => lines.push(line));
  assert.equal(exitCode, 5);
  assert.deepEqual(lines, ['{"message_id":"om_test"}']);
  assert.ok(Date.now() - startedAt < 1_000, 'must not wait for descendant-held stdout');
}

console.log('EVENT_CONSUMER_TEST_OK');
