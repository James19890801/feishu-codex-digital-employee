import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { A1Synchronizer } from './a1-sync.mjs';
import { AgentState } from './state.mjs';

const dir = mkdtempSync(join(tmpdir(), 'james-a1-sync-'));
const state = new AgentState(join(dir, 'state.sqlite'));
try {
  state.registerA1Subscription({
    workitemId: '90000001', projectId: '2165415', chatId: 'dingtalk:user:1',
    senderId: 'dingtalk:1', chatType: 'p2p',
    snapshot: {
      id: '90000001', title: '支付流程', status: '待处理', assignee: '黑撒',
      url: 'https://project.aone.alibaba-inc.com/v2/project/2165415/req/90000001',
      updatedAt: '2026-08-03 10:00:00',
    },
  });
  let currentStatus = '开发中';
  const delivered = [];
  const synchronizer = new A1Synchronizer({
    client: {
      async getWorkitem(id) {
        return {
          id, title: '支付流程', status: currentStatus, assignee: '黑撒',
          url: `https://project.aone.alibaba-inc.com/v2/project/2165415/req/${id}`,
          updatedAt: '2026-08-03 11:00:00',
        };
      },
    },
    state,
    notify: async (chatId, content, key, recipient) => delivered.push({ chatId, content, key, recipient }),
    now: () => new Date('2026-08-03T03:00:00.000Z'),
  });

  const changed = await synchronizer.syncOnce();
  assert.equal(changed.changed, 1);
  assert.equal(changed.delivered, 1);
  assert.match(delivered[0].content, /待处理.*开发中/s);
  assert.match(delivered[0].content, /https:\/\/project\.aone/);
  assert.deepEqual(delivered[0].recipient, { senderId: 'dingtalk:1', chatType: 'p2p' });
  assert.equal(state.a1NotificationCount(), 0);

  const unchanged = await synchronizer.syncOnce();
  assert.equal(unchanged.changed, 0);
  assert.equal(delivered.length, 1);

  currentStatus = '已完成';
  const failing = new A1Synchronizer({
    client: synchronizer.client,
    state,
    notify: async () => { throw new Error('channel unavailable'); },
    now: () => new Date('2026-08-03T04:00:00.000Z'),
  });
  const failed = await failing.syncOnce();
  assert.equal(failed.changed, 1);
  assert.equal(failed.failed, 1);
  assert.equal(state.a1NotificationCount(), 1);

  console.log('a1-sync tests passed');
} finally {
  state.close();
  rmSync(dir, { recursive: true, force: true });
}
