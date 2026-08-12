import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
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
  DINGTALK_CLIENT_ID: 'cloud-app', DINGTALK_CLIENT_SECRET: 'cloud-secret',
  DINGTALK_DWS_AUTH_BUNDLE_B64: portableBundle, AIPROS_DWS_HOME: dwsHome,
  AIPROS_COORDINATOR_URL: 'https://internal.test',
  AIPROS_CONTAINER_TOKEN: 'token', AIPROS_ALLOWED_CHAT_IDS: 'chat-1',
  AIPROS_ALLOWED_SENDER_IDS: 'user-1',
};
let importedPath = '';
const runner = async (_bin, args, options = {}) => {
  calls.push(args);
  if (args[0] === 'auth' && args[1] === 'import') {
    importedPath = args[args.indexOf('-i') + 1];
    assert.equal(options.env?.HOME, dwsHome);
    assert.equal((await stat(importedPath)).mode & 0o777, 0o600);
    assert.equal(await readFile(importedPath, 'utf8'), portableBundle);
  }
  if (args[0] === 'auth' && args[1] === 'status') {
    assert.equal(options.env?.HOME, dwsHome);
    return { stdout: '{"authenticated":true}' };
  }
  return { stdout: '{}' };
};
const coordinator = {
  async ready(generation) { coordinatorCalls.push(['ready', generation]); return { ok: true }; },
  async claim(input) { coordinatorCalls.push(['claim', input]); return { accepted: true }; },
  async qoder(input) { coordinatorCalls.push(['qoder', input]); return { result: { text: '云端回答' } }; },
  async complete(input) { coordinatorCalls.push(['complete', input]); return { ok: true }; },
};
const eventCalls = [];
const eventChildren = [];
const worker = new StandbyDwsWorker({
  env, runner, coordinator, now: () => 1_786_060_800_000,
  eventConsumer: async (_bin, args, _onMessage, options = {}) => {
    eventCalls.push(args);
    assert.equal(options.env?.HOME, dwsHome);
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
assert.equal(calls.some(args => args.includes('--client-id') && args.includes('cloud-app')), true);
assert.equal(eventCalls[0].includes('--flatten'), true);
assert.deepEqual(await worker.processMessage({ messageId: 'standby' }), { skipped: 'standby' });

assert.deepEqual(await worker.activate(3), { ready: true, generation: 3 });
assert.deepEqual(await worker.activate(3), { ready: true, generation: 3 });
assert.equal(coordinatorCalls.filter(call => call[0] === 'ready').length, 1);
assert.equal(calls.filter(args => args[0] === 'chat' && args[2] === 'list').length, 1);
const result = await worker.processMessage({
  messageId: 'm1', chatId: 'chat-1', senderId: 'user-1', text: '你好', createdAt: 1_786_060_800_000,
});
assert.equal(result.sent, true);
const send = calls.find(args => args[0] === 'chat' && args[2] === 'send');
assert.match(send[send.indexOf('--text') + 1], /^【云端兜底】/);
assert.match(send[send.indexOf('--uuid') + 1], /^[a-f0-9-]{36}$/);
assert.equal(coordinatorCalls.at(-1)[0], 'complete');
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
console.log('FAILOVER_CONTAINER_WORKER_TEST_OK');
