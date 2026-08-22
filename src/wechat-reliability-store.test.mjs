import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WechatReliabilityStore,
  resolveWechatReliabilityPaths,
} from './wechat-reliability-store.mjs';

const root = await mkdtemp(join(tmpdir(), 'wechat-reliability-store-'));
try {
  const nowMs = Date.parse('2026-08-22T12:00:00.000Z');
  const store = new WechatReliabilityStore({
    home: root,
    now: () => nowMs,
    maxEvents: 3,
    maxEventBytes: 700,
  });
  const paths = resolveWechatReliabilityPaths(root);
  assert.equal(paths.statePath, join(root, 'data', 'wechat-reliability-state.json'));
  assert.equal(paths.eventsPath, join(root, 'logs', 'wechat-reliability-events.jsonl'));

  const missing = await store.load();
  assert.equal(missing.state, 'starting');
  assert.equal(missing.checkedAtMs, nowMs);

  await store.save({ ...missing, state: 'healthy', checkedAtMs: nowMs + 1 });
  assert.equal((await store.load()).state, 'healthy');
  assert.equal((await stat(paths.statePath)).mode & 0o777, 0o600);
  assert.equal((await readdir(join(root, 'data'))).some(name => name.includes('.tmp-')), false);

  await chmod(paths.statePath, 0o600);
  await writeFile(paths.statePath, '{truncated', { mode: 0o600 });
  const recovered = await store.load();
  assert.equal(recovered.state, 'starting');
  const recoveredText = await readFile(paths.statePath, 'utf8');
  assert.doesNotThrow(() => JSON.parse(recoveredText));
  const quarantined = (await readdir(join(root, 'data')))
    .filter(name => name.startsWith('wechat-reliability-state.json.corrupt-'));
  assert.equal(quarantined.length, 1);

  for (let index = 0; index < 5; index += 1) {
    await store.appendEvent({
      at: `2026-08-22T12:00:0${index}.000Z`,
      layer: 'public_callback',
      action: index % 2 ? 'restart_tunnel' : 'probe',
      elapsedMs: index + 10,
      result: index === 4 ? 'ok' : 'failed',
      errorCode: index === 4 ? null : 'http_502',
      messageText: 'private message body',
      contactId: 'wxid_private',
      token: 'super-secret-token',
      callbackUrl: 'https://wechat.example.com/webhooks/gewe/secret',
    });
  }
  const eventText = await readFile(paths.eventsPath, 'utf8');
  const events = eventText.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(events.length, 3);
  assert.equal(events[0].elapsedMs, 12);
  assert.equal(events[2].result, 'ok');
  assert.equal(Buffer.byteLength(eventText) <= 700, true);
  for (const forbidden of [
    'private message body',
    'wxid_private',
    'super-secret-token',
    'wechat.example.com',
    '/webhooks/gewe/',
  ]) {
    assert.equal(eventText.includes(forbidden), false, forbidden);
  }
  assert.equal((await stat(paths.eventsPath)).mode & 0o777, 0o600);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('WECHAT_RELIABILITY_STORE_TEST_OK');
