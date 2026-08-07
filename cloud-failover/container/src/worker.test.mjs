import assert from 'node:assert/strict';
import { access, stat } from 'node:fs/promises';
import { StandbyDwsWorker } from './worker.mjs';

const calls = [];
const coordinatorCalls = [];
const env = {
  DINGTALK_CLIENT_ID: 'cloud-app', DINGTALK_CLIENT_SECRET: 'cloud-secret',
  DINGTALK_DWS_AUTH_BUNDLE_B64: 'portable-bundle', AIPROS_COORDINATOR_URL: 'https://internal.test',
  AIPROS_CONTAINER_TOKEN: 'token', AIPROS_ALLOWED_CHAT_IDS: 'chat-1',
  AIPROS_ALLOWED_SENDER_IDS: 'user-1', AIPROS_GENERATION: '3',
};
let importedPath = '';
const runner = async (_bin, args) => {
  calls.push(args);
  if (args[0] === 'auth' && args[1] === 'import') {
    importedPath = args[args.indexOf('-i') + 1];
    assert.equal((await stat(importedPath)).mode & 0o777, 0o600);
  }
  if (args[0] === 'auth' && args[1] === 'status') return { stdout: '{"authenticated":true}' };
  return { stdout: '{}' };
};
const coordinator = {
  async ready(generation) { coordinatorCalls.push(['ready', generation]); return { ok: true }; },
  async claim(input) { coordinatorCalls.push(['claim', input]); return { accepted: true }; },
  async qoder(input) { coordinatorCalls.push(['qoder', input]); return { result: { text: '云端回答' } }; },
  async complete(input) { coordinatorCalls.push(['complete', input]); return { ok: true }; },
};
const eventCalls = [];
const worker = new StandbyDwsWorker({
  env, runner, coordinator, now: () => 1_786_060_800_000,
  eventConsumer: async (_bin, args) => { eventCalls.push(args); return { pid: 1 }; },
});
assert.deepEqual(await worker.bootstrap(3), { ready: true, generation: 3 });
await assert.rejects(() => access(importedPath));
assert.equal(calls.some(args => args.includes('--profile')), false);
assert.equal(calls.some(args => args.includes('--client-id') && args.includes('cloud-app')), true);
assert.equal(eventCalls[0].includes('--flatten'), true);
assert.equal(calls.some(args => args[0] === 'chat' && args[2] === 'list'
  && args.includes('newer')), true);
const result = await worker.processMessage({
  messageId: 'm1', chatId: 'chat-1', senderId: 'user-1', text: '你好', createdAt: 1_786_060_800_000,
});
assert.equal(result.sent, true);
const send = calls.find(args => args[0] === 'chat' && args[2] === 'send');
assert.match(send[send.indexOf('--text') + 1], /^【云端兜底】/);
assert.match(send[send.indexOf('--uuid') + 1], /^[a-f0-9-]{36}$/);
assert.equal(coordinatorCalls.at(-1)[0], 'complete');
console.log('FAILOVER_CONTAINER_WORKER_TEST_OK');
