import assert from 'node:assert/strict';
import {
  processFailureSummary,
  runBufferedProcess,
  terminateAllBufferedProcesses,
} from './process-runner.mjs';

assert.equal(
  processFailureSummary({
    message: 'process timed out after 45000ms',
    stderr: '{"error":{"message":"keychain Get failed: keychain access blocked"}}',
  }),
  'keychain Get failed: keychain access blocked',
);
assert.equal(
  processFailureSummary({ message: 'plain failure', stderr: '' }),
  'plain failure',
);
assert.equal(
  processFailureSummary({
    message: 'process exited with code 1',
    stderr: 'Authentication required. Run qodercli login.',
  }),
  'Authentication required. Run qodercli login.',
);

{
  const result = await runBufferedProcess(process.execPath, [
    '-e', 'process.stdout.write("ok"); process.stderr.write("warn")',
  ], { timeoutMs: 2_000 });
  assert.equal(result.stdout, 'ok');
  assert.equal(result.stderr, 'warn');
}

{
  const result = await runBufferedProcess(process.execPath, [
    '-e', 'const fs=require("fs"); process.stdout.write(String(fs.fstatSync(0).isSocket()))',
  ], { timeoutMs: 2_000 });
  assert.equal(result.stdout, 'false');
}

{
  const result = await runBufferedProcess(process.execPath, [
    '-e', 'process.stdin.pipe(process.stdout)',
  ], { input: 'input-ok', timeoutMs: 2_000 });
  assert.equal(result.stdout, 'input-ok');
}

{
  const startedAt = Date.now();
  const result = await runBufferedProcess('/bin/sh', [
    '-c', "printf '{\"ok\":true}'; sleep 10",
  ], {
    timeoutMs: 10_000,
    completeOnStdout: stdout => {
      try { return JSON.parse(stdout).ok === true; } catch { return false; }
    },
  });
  assert.equal(JSON.parse(result.stdout).ok, true);
  assert.equal(result.completedEarly, true);
  assert.ok(Date.now() - startedAt < 5_000);
}

{
  await assert.rejects(
    runBufferedProcess(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], {
      timeoutMs: 100,
      killGraceMs: 50,
    }),
    error => error?.code === 'PROCESS_TIMEOUT',
  );
}

{
  await assert.rejects(
    runBufferedProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], {
      timeoutMs: 2_000,
      maxStdoutBytes: 100,
    }),
    error => error?.code === 'PROCESS_OUTPUT_LIMIT',
  );
}

{
  const result = await runBufferedProcess(
    process.execPath,
    ['-e', 'process.exit(0)'],
    {
      input: 'x'.repeat(20 * 1024 * 1024),
      timeoutMs: 2_000,
    },
  );
  assert.equal(result.exitCode, 0);
}

{
  const running = runBufferedProcess(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000)'],
    { timeoutMs: 10_000, killGraceMs: 50 },
  );
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(terminateAllBufferedProcesses(), 1);
  await assert.rejects(running, error => error?.code === 'PROCESS_TERMINATED');
}

console.log('PROCESS_RUNNER_TEST_OK');
