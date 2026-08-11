import assert from 'node:assert/strict';
import * as aiRuntime from './ai-runtime.mjs';
import {
  AiRuntimeClient,
  buildAiRuntimeInvocation,
  discoverAiRuntimes,
  selectAiRuntime,
} from './ai-runtime.mjs';

const executablePaths = new Set([
  '/Applications/Codex.app/Contents/Resources/codex',
  '/Applications/QoderWork.app/Contents/Resources/bin/qodercli',
  '/Applications/TRAE SOLO CN.app/Contents/Resources/app/bin/trae-solo-cn',
]);
const runtimes = discoverAiRuntimes({
  candidates: {
    codex: ['/Applications/Codex.app/Contents/Resources/codex'],
    qoder: ['/Applications/QoderWork.app/Contents/Resources/bin/qodercli'],
    codebuddy: ['/usr/local/bin/codebuddy'],
    trae: ['/usr/local/bin/trae-cli'],
  },
  installedCandidates: {
    trae: ['/Applications/TRAE SOLO CN.app/Contents/Resources/app/bin/trae-solo-cn'],
  },
  isExecutable: path => executablePaths.has(path),
});

assert.deepEqual(runtimes.map(item => item.id), ['codex', 'qoder', 'codebuddy', 'trae']);
assert.equal(runtimes.find(item => item.id === 'codex').available, true);
assert.equal(runtimes.find(item => item.id === 'qoder').available, true);
assert.equal(runtimes.find(item => item.id === 'codebuddy').installed, false);
assert.equal(runtimes.find(item => item.id === 'trae').installed, true);
assert.equal(runtimes.find(item => item.id === 'trae').available, false);
assert.match(runtimes.find(item => item.id === 'trae').reason, /headless/i);

assert.equal(selectAiRuntime(runtimes, 'auto').id, 'codex');
assert.equal(selectAiRuntime(runtimes, 'qoder').id, 'qoder');
assert.throws(() => selectAiRuntime(runtimes, 'trae'), /not available/i);

const qoderInvocation = buildAiRuntimeInvocation(
  runtimes.find(item => item.id === 'qoder'),
  {
    cwd: '/tmp/james-runtime',
    model: '',
    images: ['/tmp/screenshot.png'],
  },
);
assert.equal(qoderInvocation.args.includes('-p'), true);
assert.equal(qoderInvocation.args.includes('dont_ask'), true);
assert.equal(qoderInvocation.args.includes('--attachment'), true);
assert.equal(qoderInvocation.args.includes('private prompt'), false);
assert.equal(
  qoderInvocation.args.includes('--max-output-tokens'),
  false,
  'Qoder versions accept different token-size syntaxes, so James must use the provider default',
);

const codexInvocation = buildAiRuntimeInvocation(
  runtimes.find(item => item.id === 'codex'),
  {
    cwd: '/tmp/james-runtime',
    model: 'gpt-5.6-terra',
    images: [],
  },
);
assert.equal(codexInvocation.args.includes('exec'), true);
assert.equal(codexInvocation.args.includes('gpt-5.6-terra'), true);

const calls = [];
const client = new AiRuntimeClient({
  runtime: runtimes.find(item => item.id === 'qoder'),
  runner: async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: 'JAMES_RUNTIME_OK\n', stderr: '' };
  },
});
const result = await client.run('private prompt', {
  cwd: '/tmp/james-runtime',
  timeoutMs: 30_000,
});
assert.equal(result.text, 'JAMES_RUNTIME_OK');
assert.equal(calls[0].options.input, 'private prompt');
assert.equal(calls[0].args.includes('private prompt'), false);

const privateFailureSentinel = 'PRIVATE_CHAT_SENTINEL_MUST_NOT_PERSIST';
const failingClient = new AiRuntimeClient({
  runtime: runtimes.find(item => item.id === 'qoder'),
  runner: async () => {
    const error = new Error(`process stderr included ${privateFailureSentinel}`);
    error.code = 'PROCESS_EXIT';
    throw error;
  },
});
await assert.rejects(
  () => failingClient.run('private prompt', { cwd: '/tmp/james-runtime' }),
  error => {
    assert.equal(error.message, 'Qoder CLI failed: PROCESS_EXIT');
    assert.doesNotMatch(error.message, new RegExp(privateFailureSentinel));
    return true;
  },
);

const emptyResponseClient = new AiRuntimeClient({
  runtime: runtimes.find(item => item.id === 'qoder'),
  runner: async () => ({ stdout: '', stderr: privateFailureSentinel }),
});
await assert.rejects(
  () => emptyResponseClient.run('private prompt', { cwd: '/tmp/james-runtime' }),
  error => {
    assert.equal(error.message, 'Qoder CLI failed: AI_RUNTIME_EMPTY_RESPONSE');
    assert.doesNotMatch(error.message, new RegExp(privateFailureSentinel));
    return true;
  },
);

assert.equal(typeof aiRuntime.runAiRuntimeStartupProbe, 'function');
const probeClient = new AiRuntimeClient({
  runtime: runtimes.find(item => item.id === 'qoder'),
  runner: async () => ({ stdout: 'AIPR0S_RUNTIME_OK\n', stderr: '' }),
});
const probeResult = await aiRuntime.runAiRuntimeStartupProbe(probeClient, {
  cwd: '/tmp/james-runtime',
  timeoutMs: 30_000,
});
assert.equal(probeResult.text, 'AIPR0S_RUNTIME_OK');
await assert.rejects(
  () => aiRuntime.runAiRuntimeStartupProbe(client, {
    cwd: '/tmp/james-runtime',
    timeoutMs: 30_000,
  }),
  /unexpected response/i,
);

console.log('AI_RUNTIME_TEST_OK');
