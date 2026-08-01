import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WeChatPocDashboardControl } from './dashboard-control.mjs';

const directory = await mkdtemp(join(tmpdir(), 'aipro-wechat-dashboard-'));
const audits = [];
const controller = new WeChatPocDashboardControl({
  directory,
  now: () => '2026-08-01T03:00:00.000Z',
  audit: event => audits.push(event),
  processAlive: pid => pid === 4321,
});

try {
  const initial = await controller.status();
  assert.equal(initial.control.enabled, false);
  assert.equal(initial.state, 'not_installed');

  await assert.rejects(
    () => controller.setEnabled(true, { confirmed: false }),
    /confirmation/i,
  );
  const enabled = await controller.setEnabled(true, {
    confirmed: true,
    actor: 'local-dashboard',
  });
  assert.equal(enabled.control.enabled, true);
  assert.equal(enabled.control.generation, 1);
  assert.equal(audits.at(-1).event, 'wechat_poc_control_changed');

  await writeFile(join(directory, 'status.json'), JSON.stringify({
    version: 1,
    pid: 4321,
    processAlive: true,
    state: 'online',
    permissionState: 'granted',
    clientRunning: true,
    lastReceiveAt: '2026-08-01T03:01:00.000Z',
    lastReplyAt: '2026-08-01T03:01:02.000Z',
    lastAction: 'reply_sent',
    queue: { pending: 1 },
  }));
  const online = await controller.status();
  assert.equal(online.processAlive, true);
  assert.equal(online.permissionState, 'granted');
  assert.equal(online.pending, 1);

  const stopped = await controller.emergencyStop({ actor: 'local-dashboard' });
  assert.equal(stopped.control.enabled, false);
  assert.equal(stopped.control.generation, 2);
  assert.equal(audits.at(-1).event, 'wechat_poc_emergency_stopped');
  console.log('WECHAT_POC_DASHBOARD_CONTROL_TEST_OK');
} finally {
  await rm(directory, { recursive: true, force: true });
}
