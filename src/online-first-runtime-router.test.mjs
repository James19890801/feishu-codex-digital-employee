import assert from 'node:assert/strict';
import { OnlineFirstRuntimeRouter } from './online-first-runtime-router.mjs';

function runtimeClient(id, run) {
  return { runtime: { id, label: id === 'ai-lab' ? 'AI-Lab Agent（预发）' : 'Codex CLI' }, run };
}

let now = 1_000;
let onlineCalls = 0;
let localCalls = 0;
const router = new OnlineFirstRuntimeRouter({
  onlineClient: runtimeClient('ai-lab', async () => {
    onlineCalls += 1;
    throw new Error('AI-Lab Agent failed: NETWORK_ERROR');
  }),
  localClient: runtimeClient('codex', async () => {
    localCalls += 1;
    return { text: '本地降级回复', runtime: { id: 'codex', label: 'Codex CLI' } };
  }),
  circuitOpenMs: 30_000,
  now: () => now,
});

const fallback = await router.run('线上技术故障时继续服务');
assert.equal(fallback.text, '本地降级回复');
assert.deepEqual(fallback.route, {
  strategy: 'online-first', primary: 'ai-lab', active: 'codex', fallback: true,
  fallbackReason: 'NETWORK_ERROR',
});
assert.equal(onlineCalls, 1);
assert.equal(localCalls, 1);

await router.run('熔断窗口内直接使用本地');
assert.equal(onlineCalls, 1);
assert.equal(localCalls, 2);

now += 30_000;
await router.run('熔断结束后重新探测线上');
assert.equal(onlineCalls, 2);
assert.equal(localCalls, 3);

let permissionFallbackCalls = 0;
const permissionRouter = new OnlineFirstRuntimeRouter({
  onlineClient: runtimeClient('ai-lab', async () => { throw new Error('AI-Lab Agent failed: HTTP_401'); }),
  localClient: runtimeClient('codex', async () => {
    permissionFallbackCalls += 1;
    return { text: '不应执行' };
  }),
});
await assert.rejects(() => permissionRouter.run('权限问题不能被降级掩盖'), /HTTP_401/);
assert.equal(permissionFallbackCalls, 0);

const onlineSuccessRouter = new OnlineFirstRuntimeRouter({
  onlineClient: runtimeClient('ai-lab', async () => ({
    text: '线上回复', runtime: { id: 'ai-lab', label: 'AI-Lab Agent（预发）' },
  })),
  localClient: runtimeClient('codex', async () => { throw new Error('online success must not call local'); }),
});
const online = await onlineSuccessRouter.run('正常请求');
assert.equal(online.text, '线上回复');
assert.deepEqual(online.route, {
  strategy: 'online-first', primary: 'ai-lab', active: 'ai-lab', fallback: false,
  fallbackReason: '',
});

let imageOnlineCalls = 0;
const imageRouter = new OnlineFirstRuntimeRouter({
  onlineClient: {
    runtime: { id: 'ai-lab', label: 'AI-Lab Agent（预发）', supportsImages: false },
    async run() { imageOnlineCalls += 1; return { text: '不应丢弃图片' }; },
  },
  localClient: {
    runtime: { id: 'codex', label: 'Codex CLI', supportsImages: true },
    async run() { return { text: '本地图片回复', runtime: this.runtime }; },
  },
});
const imageFallback = await imageRouter.run('分析图片', { images: ['/tmp/evidence.png'] });
assert.equal(imageFallback.text, '本地图片回复');
assert.equal(imageFallback.route.fallbackReason, 'UNSUPPORTED_IMAGES');
assert.equal(imageOnlineCalls, 0);

console.log('ONLINE_FIRST_RUNTIME_ROUTER_TEST_OK');
