import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { EventEmitter, once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoordinatorClient, StandbyDwsWorker, createHealthServer } from './worker.mjs';

const calls = [];
const coordinatorCalls = [];
const credentialDir = await mkdtemp(join(tmpdir(), 'aipros-dws-worker-test-'));
const dwsHome = join(credentialDir, 'home');
const portableBundle = Buffer.from('dws-1.0.56-portable-auth-tarball').toString('base64');
const env = {
  DINGTALK_DWS_AUTH_BUNDLE_B64: portableBundle, AIPROS_DWS_HOME: dwsHome,
  AIPROS_CLOUD_DWS_CHANNEL: 'cloud-channel',
  AIPROS_COORDINATOR_URL: 'https://internal.test',
  AIPROS_CONTAINER_TOKEN: 'token', AIPROS_ACCESS_MODE: 'blacklist',
  AIPROS_BLOCKED_CHAT_IDS: 'blocked-chat', AIPROS_BLOCKED_SENDER_IDS: 'blocked-user',
};
let importedPath = '';
const runner = async (_bin, args, options = {}) => {
  calls.push(args);
  if (args[0] === 'auth' && args[1] === 'import') {
    importedPath = args[args.indexOf('-i') + 1];
    assert.equal(options.env?.HOME, dwsHome);
    assert.equal(options.env?.DWS_CHANNEL, 'cloud-channel');
    assert.equal((await stat(importedPath)).mode & 0o777, 0o600);
    assert.equal(await readFile(importedPath, 'utf8'), portableBundle);
  }
  if (args[0] === 'auth' && args[1] === 'status') {
    assert.equal(options.env?.HOME, dwsHome);
    assert.equal(options.env?.DWS_CHANNEL, 'cloud-channel');
    return { stdout: '{"authenticated":true}' };
  }
  if (args[0] === 'chat' && args[1] === 'message' && args[2] === 'send') {
    return { stdout: '{"result":{"openTaskId":"task-1"}}' };
  }
  if (args[0] === 'chat' && args[1] === 'message' && args[2] === 'query-send-status') {
    return { stdout: '{"result":{"sendStatus":"SUCCESS"}}' };
  }
  if (args[0] === 'chat' && args[1] === 'message' && args[2] === 'download-media') {
    const output = args[args.indexOf('--output') + 1];
    await writeFile(output, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
    return { stdout: '{"ok":true}' };
  }
  return { stdout: '{}' };
};
const coordinator = {
  async ready(generation) { coordinatorCalls.push(['ready', generation]); return { ok: true }; },
  async claim(input) { coordinatorCalls.push(['claim', input]); return { accepted: true }; },
  async qoder(input) { coordinatorCalls.push(['qoder', input]); return { result: { text: '云端回答' } }; },
  async vision(input) { coordinatorCalls.push(['vision', input]); return { text: '一张测试截图' }; },
  async complete(input) { coordinatorCalls.push(['complete', input]); return { ok: true }; },
};
const eventCalls = [];
const eventChildren = [];
const worker = new StandbyDwsWorker({
  env, runner, coordinator, now: () => 1_786_060_800_000,
  eventConsumer: async (_bin, args, _onMessage, options = {}) => {
    eventCalls.push(args);
    assert.equal(options.env?.HOME, dwsHome);
    assert.equal(options.env?.DWS_CHANNEL, 'cloud-channel');
    const child = new EventEmitter();
    eventChildren.push(child);
    return child;
  },
});
await worker.initialize();
await worker.initialize();
await assert.rejects(() => access(importedPath));
await access(join(dwsHome, '.aipros-auth-bootstrap-complete'));
assert.equal(eventCalls.length, 1);
assert.equal(calls.filter(args => args[0] === 'auth' && args[1] === 'import').length, 1);
assert.equal(calls.some(args => args.includes('--profile')), false);
assert.equal(calls.some(args => args.includes('--client-id') || args.includes('--client-secret')), false);
assert.equal(eventCalls[0].includes('--flatten'), true);
assert.deepEqual(eventCalls[0].slice(0, 5), [
  'event', 'consume',
  'user_im_message_receive_at',
  'user_im_message_receive_o2o_all',
  '--flatten',
]);
assert.deepEqual(await worker.processMessage({ messageId: 'standby' }), { skipped: 'standby' });

assert.deepEqual(await worker.activate(3), { ready: true, generation: 3 });
assert.deepEqual(await worker.activate(3), { ready: true, generation: 3 });
assert.equal(coordinatorCalls.filter(call => call[0] === 'ready').length, 1);
const backfillCalls = calls.filter(args => args[0] === 'chat' && args[1] === 'message' && args[2] === 'list-mentions');
assert.equal(backfillCalls.length, 1);
assert.equal(backfillCalls[0].includes('--group'), false);
assert.equal(backfillCalls[0].includes('--start'), true);
assert.equal(backfillCalls[0].includes('--end'), true);
const result = await worker.processMessage({
  messageId: 'm1', chatId: 'chat-1', senderId: 'user-1', text: '你好', createdAt: 1_786_060_800_000,
});
assert.equal(result.sent, true);
const send = calls.find(args => args[0] === 'chat' && args[2] === 'send');
assert.equal(send[send.indexOf('--text') + 1], '云端回答');
assert.match(send[send.indexOf('--uuid') + 1], /^[a-f0-9-]{36}$/);
assert.equal(send.includes('--format'), true);
const sendStatus = calls.find(args => args[0] === 'chat' && args[2] === 'query-send-status');
assert.equal(sendStatus[sendStatus.indexOf('--open-task-id') + 1], 'task-1');
assert.equal(coordinatorCalls.at(-1)[0], 'complete');

const imageResult = await worker.processMessage({
  type: 'user_im_message_receive_o2o_all',
  message_id: 'm-image', conversation_id: 'chat-1', sender_open_dingtalk_id: 'user-1',
  content: '[图片消息](mediaId=image-resource-1) 这是什么？', create_time: 1_786_060_800_000,
});
assert.equal(imageResult.sent, true);
assert.equal(calls.some(args => args[0] === 'chat' && args[2] === 'download-media'), true);
const visionCall = coordinatorCalls.find(call => call[0] === 'vision');
assert.equal(visionCall[1].image.startsWith('data:image/png;base64,'), true);
const imageQoderCall = coordinatorCalls.filter(call => call[0] === 'qoder').at(-1)[1];
assert.match(imageQoderCall.prompt, /视觉模型.*识别结果/s);
assert.match(imageQoderCall.prompt, /测试截图/);
assert.match(imageQoderCall.prompt, /这是什么/);
assert.doesNotMatch(imageQoderCall.prompt, /image-resource-1/);
worker.deactivate();
assert.deepEqual(await worker.processMessage({ messageId: 'after-drain' }), { skipped: 'standby' });
eventChildren[0].emit('exit', 1);
assert.equal(worker.authenticated, false);
assert.equal(worker.backfilledGeneration, 0);
await worker.initialize();
assert.equal(eventCalls.length, 2);
assert.equal(calls.filter(args => args[0] === 'auth' && args[1] === 'import').length, 1);

const clientPaths = [];
const client = new CoordinatorClient({
  baseUrl: 'https://coordinator.test/', token: 'secret',
  fetchImpl: async (url, init) => {
    clientPaths.push([new URL(url).pathname, init.headers.authorization]);
    return new Response(JSON.stringify({ ok: true, state: 'LOCAL_PRIMARY', generation: 0 }));
  },
});
await client.lease();
assert.deepEqual(clientPaths[0], ['/internal/runtime/lease', 'Bearer secret']);

const server = createHealthServer(worker, 0);
await once(server, 'listening');
const port = server.address().port;
const live = await fetch(`http://127.0.0.1:${port}/live`);
assert.equal(live.status, 200);
assert.deepEqual(await live.json(), { ok: true });
const ready = await fetch(`http://127.0.0.1:${port}/ready`);
assert.equal(ready.status, 200);
assert.deepEqual(await ready.json(), { ok: true, active: false });
await new Promise(resolve => server.close(resolve));
await rm(credentialDir, { recursive: true, force: true });

const overrideCalls = [];
const overrideHome = join(await mkdtemp(join(tmpdir(), 'aipros-dws-worker-override-test-')), 'home');
const overrideWorker = new StandbyDwsWorker({
  env: {
    ...env,
    AIPROS_DWS_HOME: overrideHome,
    DINGTALK_CLIENT_ID: 'cloud-app',
    DINGTALK_CLIENT_SECRET: 'cloud-secret',
  },
  coordinator,
  runner: async (_bin, args) => {
    overrideCalls.push(args);
    return { stdout: args[0] === 'auth' && args[1] === 'status' ? '{"authenticated":true}' : '{}' };
  },
  eventConsumer: async () => new EventEmitter(),
});
await overrideWorker.initialize();
assert.equal(overrideCalls.some(args => args.includes('--client-id') && args.includes('cloud-app')), true);
await rm(join(overrideHome, '..'), { recursive: true, force: true });
console.log('FAILOVER_CONTAINER_WORKER_TEST_OK');
