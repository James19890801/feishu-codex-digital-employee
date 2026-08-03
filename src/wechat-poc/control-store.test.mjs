import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WeChatPocControlStore } from './control-store.mjs';

const directory = await mkdtemp(join(tmpdir(), 'aipro-wechat-control-'));
const fixedNow = '2026-08-01T03:00:00.000Z';

try {
  const store = new WeChatPocControlStore({ directory, now: () => fixedNow });
  assert.deepEqual(await store.read(), {
    version: 1,
    enabled: false,
    generation: 0,
    boundaryAt: '',
    updatedAt: '',
    reason: 'not_initialized',
  });

  const initialized = await store.initialize({ enabledByDefault: true });
  assert.equal(initialized.enabled, true);
  assert.equal(initialized.generation, 1);
  assert.equal(initialized.boundaryAt, fixedNow);
  assert.equal(initialized.reason, 'auto_enabled');

  const preserved = await store.initialize({ enabledByDefault: true });
  assert.deepEqual(preserved, initialized, 'restart must preserve the operator switch');

  await writeFile(join(directory, 'control.json'), '{bad json', { mode: 0o600 });
  assert.equal((await store.read()).enabled, false);
  assert.equal((await store.read()).reason, 'invalid_control_state');

  const enabled = await store.setEnabled(true, { reason: 'operator' });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.generation, 1);
  assert.equal(enabled.boundaryAt, fixedNow);
  assert.equal(enabled.updatedAt, fixedNow);
  assert.equal(enabled.reason, 'operator');

  const restartedWhileEnabled = await store.advanceGeneration('worker_restart');
  assert.equal(restartedWhileEnabled.enabled, true);
  assert.equal(restartedWhileEnabled.generation, 2);
  assert.equal(restartedWhileEnabled.reason, 'worker_restart');

  const fileInfo = await stat(join(directory, 'control.json'));
  assert.equal(fileInfo.mode & 0o777, 0o600);
  assert.deepEqual(
    (await readdir(directory)).filter(name => name.includes('.tmp-')),
    [],
  );

  const restarted = await store.failClosed('worker_start');
  assert.equal(restarted.enabled, false);
  assert.equal(restarted.generation, 3);
  assert.equal(restarted.boundaryAt, fixedNow);
  assert.equal(restarted.reason, 'worker_start');
  assert.deepEqual(await store.read(), restarted);

  console.log('WECHAT_POC_CONTROL_STORE_TEST_OK');
} finally {
  await rm(directory, { recursive: true, force: true });
}
