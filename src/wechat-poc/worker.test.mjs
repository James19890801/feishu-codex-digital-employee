import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WeChatPocWorker } from './worker.mjs';

const directory = await mkdtemp(join(tmpdir(), 'james-wechat-worker-'));
const statusPath = join(directory, 'status.json');
let resolveTick;
let tickCalls = 0;
let enabled = true;
const bridge = {
  async initialize() {
    return { version: 1, enabled: true, generation: 1, reason: 'auto_enabled' };
  },
  async tick() {
    tickCalls += 1;
    await new Promise(resolve => { resolveTick = resolve; });
    return { scanned: 1, accepted: 1, secretText: '不得写入状态' };
  },
  async stop(reason) {
    return { enabled, reason };
  },
};
const controlStore = {
  async read() {
    return { version: 1, enabled, generation: 1, reason: enabled ? 'auto_enabled' : 'SIGTERM' };
  },
};
const state = {
  statusCounts() { return { pending: 0, completed: 1 }; },
};
const worker = new WeChatPocWorker({
  bridge,
  controlStore,
  state,
  statusPath,
  now: () => '2026-08-01T03:00:00.000Z',
});

try {
  await worker.initialize();
  const initial = JSON.parse(await readFile(statusPath, 'utf8'));
  assert.equal(initial.control.enabled, true);
  assert.equal(initial.state, 'online');

  const first = worker.runOnce();
  const overlapping = await worker.runOnce();
  assert.equal(overlapping.skipped, 'tick_in_progress');
  assert.equal(tickCalls, 1);
  resolveTick();
  await first;

  const afterTickText = await readFile(statusPath, 'utf8');
  assert.equal(afterTickText.includes('不得写入状态'), false);
  const afterTick = JSON.parse(afterTickText);
  assert.equal(afterTick.lastTickAt, '2026-08-01T03:00:00.000Z');
  assert.deepEqual(afterTick.queue, { pending: 0, completed: 1 });

  await worker.shutdown('SIGTERM');
  const stopped = JSON.parse(await readFile(statusPath, 'utf8'));
  assert.equal(stopped.control.enabled, true);
  assert.equal(stopped.lastAction, 'SIGTERM');
  console.log('WECHAT_POC_WORKER_TEST_OK');
} finally {
  await rm(directory, { recursive: true, force: true });
}
