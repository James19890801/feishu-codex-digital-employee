import assert from 'node:assert/strict';
import {
  AiRuntimeClient,
  buildAiRuntimeInvocation,
  discoverAiRuntimes,
  selectAiRuntime,
} from './ai-runtime.mjs';

const executablePaths = new Set([
  '/Applications/Codex.app/Contents/Resources/codex',
  '/Applications/QoderWork.app/Contents/Resources/bin/qodercli',
  '/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy',
  '/Applications/TRAE SOLO CN.app/Contents/Resources/app/bin/trae-solo-cn',
]);
const runtimes = discoverAiRuntimes({
  candidates: {
    workbuddy: ['/usr/local/bin/workbuddy-cli'],
    qoder_work: ['/Applications/QoderWork.app/Contents/Resources/bin/qodercli'],
    qoder: ['/usr/local/bin/qodercli'],
    codebuddy: ['/usr/local/bin/codebuddy'],
    codex: ['/Applications/Codex.app/Contents/Resources/codex'],
    trae: ['/usr/local/bin/trae-cli'],
  },
  installedCandidates: {
    workbuddy: ['/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy'],
    trae: ['/Applications/TRAE SOLO CN.app/Contents/Resources/app/bin/trae-solo-cn'],
  },
  isExecutable: path => executablePaths.has(path),
});

assert.deepEqual(runtimes.map(item => item.id), [
  'workbuddy',
  'qoder_work',
  'qoder',
  'codebuddy',
  'codex',
  'trae',
]);
assert.equal(runtimes.find(item => item.id === 'workbuddy').installed, true);
assert.equal(runtimes.find(item => item.id === 'workbuddy').available, false);
assert.match(runtimes.find(item => item.id === 'workbuddy').reason, /headless/i);
assert.equal(runtimes.find(item => item.id === 'qoder_work').available, true);
assert.equal(runtimes.find(item => item.id === 'codex').available, true);
assert.equal(runtimes.find(item => item.id === 'qoder').available, false);
assert.equal(runtimes.find(item => item.id === 'codebuddy').installed, false);
assert.equal(runtimes.find(item => item.id === 'trae').installed, true);
assert.equal(runtimes.find(item => item.id === 'trae').available, false);
assert.match(runtimes.find(item => item.id === 'trae').reason, /headless/i);

assert.equal(selectAiRuntime(runtimes, 'auto').id, 'qoder_work');
assert.equal(selectAiRuntime(runtimes, 'qoder_work').id, 'qoder_work');
assert.throws(() => selectAiRuntime(runtimes, 'trae'), /not available/i);

const qoderInvocation = buildAiRuntimeInvocation(
  runtimes.find(item => item.id === 'qoder_work'),
  {
    cwd: '/tmp/aipro-runtime',
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
  'Qoder versions accept different token-size syntaxes, so AIPRO must use the provider default',
);

const codexInvocation = buildAiRuntimeInvocation(
  runtimes.find(item => item.id === 'codex'),
  {
    cwd: '/tmp/aipro-runtime',
    model: 'gpt-5.6-terra',
    images: [],
  },
);
assert.equal(codexInvocation.args.includes('exec'), true);
assert.equal(codexInvocation.args.includes('gpt-5.6-terra'), true);

const calls = [];
const client = new AiRuntimeClient({
  runtime: runtimes.find(item => item.id === 'qoder_work'),
  runner: async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: 'AIPRO_RUNTIME_OK\n', stderr: '' };
  },
});
const result = await client.run('private prompt', {
  cwd: '/tmp/aipro-runtime',
  timeoutMs: 30_000,
});
assert.equal(result.text, 'AIPRO_RUNTIME_OK');
assert.equal(calls[0].options.input, 'private prompt');
assert.equal(calls[0].args.includes('private prompt'), false);

console.log('AI_RUNTIME_TEST_OK');
