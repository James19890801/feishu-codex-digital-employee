import assert from 'node:assert/strict';
import { LocalFirstRuntimeRouter } from './local-first-runtime-router.mjs';

const retryableErrors = [
  new Error('process timed out after 40000ms'),
  new Error('process exited with code 1'),
  new Error('fetch failed: ECONNRESET'),
];
const attemptTimeouts = [];
let cloudCalls = 0;
let cloudInput = null;
const router = new LocalFirstRuntimeRouter({
  localClient: {
    runtime: { id: 'codex', label: 'Codex CLI' },
    async run(_prompt, options) {
      attemptTimeouts.push(options.timeoutMs);
      throw retryableErrors.shift();
    },
  },
  cloudClient: {
    async execute(input) {
      cloudCalls += 1;
      cloudInput = input;
      return { text: 'cloud answer', sessionId: 'sess_123', latencyMs: 42 };
    },
  },
  attempts: 3,
  delay: async () => {},
  now: () => 0,
});

const result = await router.run(
  '请读取 /Users/alice/private.txt marker cloud-secret-value',
  { timeoutMs: 120_000 },
  {
    level: 'L0',
    handoffKey: 'message-123',
    cloudPrompt: '只回答当前问题 /Users/alice/private.txt marker cloud-secret-value',
    forbiddenValues: ['cloud-secret-value'],
  },
);
assert.equal(cloudCalls, 1);
assert.deepEqual(attemptTimeouts, [40_000, 40_000, 40_000]);
assert.equal(cloudInput.prompt.includes('/Users/alice'), false);
assert.equal(cloudInput.prompt.includes('请读取'), false, 'the full local prompt must not enter cloud');
assert.equal(cloudInput.prompt.includes('cloud-secret-value'), false);
assert.equal(cloudInput.handoffKey, 'message-123');
assert.match(cloudInput.digest, /^[a-f0-9]{64}$/);
assert.deepEqual(result, {
  text: 'cloud answer',
  stdout: 'cloud answer',
  stderr: '',
  runtime: { id: 'qoder-cloud', label: 'Qoder Cloud Agent' },
  cloud: { sessionId: 'sess_123', latencyMs: 42, handoff: null },
});

let localSuccessCalls = 0;
let unexpectedCloudCalls = 0;
const localSuccess = new LocalFirstRuntimeRouter({
  localClient: {
    runtime: { id: 'codex', label: 'Codex CLI' },
    async run() {
      localSuccessCalls += 1;
      return { text: 'local answer', runtime: { id: 'codex', label: 'Codex CLI' } };
    },
  },
  cloudClient: { execute: async () => { unexpectedCloudCalls += 1; } },
});
assert.equal((await localSuccess.run('hello', { timeoutMs: 30_000 }, { level: 'L0' })).text,
  'local answer');
assert.equal(localSuccessCalls, 1);
assert.equal(unexpectedCloudCalls, 0);

let businessCalls = 0;
const businessFailure = new LocalFirstRuntimeRouter({
  localClient: {
    runtime: { id: 'codex', label: 'Codex CLI' },
    async run() {
      businessCalls += 1;
      throw new Error('permission denied by owner policy');
    },
  },
  cloudClient: { execute: async () => { unexpectedCloudCalls += 1; } },
});
await assert.rejects(
  () => businessFailure.run('send it', { timeoutMs: 30_000 }, { level: 'L2' }),
  /permission denied/i,
);
assert.equal(businessCalls, 1);
assert.equal(unexpectedCloudCalls, 0);

let imageLocalCalls = 0;
const imageFailure = new LocalFirstRuntimeRouter({
  localClient: {
    runtime: { id: 'codex', label: 'Codex CLI' },
    async run() {
      imageLocalCalls += 1;
      throw new Error('process exited with code 1');
    },
  },
  cloudClient: { execute: async () => { unexpectedCloudCalls += 1; } },
  delay: async () => {},
});
await assert.rejects(
  () => imageFailure.run('看图', {
    timeoutMs: 30_000,
    images: ['/tmp/screenshot.png'],
  }, { level: 'L0' }),
  error => error?.code === 'cloud_failover_ineligible' && error?.reason === 'image',
);
assert.equal(imageLocalCalls, 3);
assert.equal(unexpectedCloudCalls, 0);

console.log('LOCAL_FIRST_RUNTIME_ROUTER_TEST_OK');
