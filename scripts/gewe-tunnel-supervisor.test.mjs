import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  QuickTunnelUrlDetector,
  updateCallbackConfiguration,
} from './gewe-tunnel-supervisor.mjs';

test('detects a quick tunnel URL split across output chunks', () => {
  const detector = new QuickTunnelUrlDetector();
  assert.equal(detector.push('INF Your quick Tunnel has been created! https://steady-personal-'), null);
  assert.equal(
    detector.push('wechat.trycloudflare.com\nINF ready'),
    'https://steady-personal-wechat.trycloudflare.com',
  );
});

test('updates only a changed GeWe callback URL and requests one restart', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gewe-tunnel-test-'));
  const configPath = path.join(directory, 'config.local.json');
  await fs.writeFile(configPath, JSON.stringify({
    geweEnabled: true,
    gewePublicCallbackBaseUrl: 'https://expired.trycloudflare.com',
    preserveMe: 'unchanged',
  }, null, 2));

  let restarts = 0;
  const changed = await updateCallbackConfiguration({
    configPath,
    publicUrl: 'https://steady-personal-wechat.trycloudflare.com',
    restart: async () => { restarts += 1; },
  });
  const unchanged = await updateCallbackConfiguration({
    configPath,
    publicUrl: 'https://steady-personal-wechat.trycloudflare.com',
    restart: async () => { restarts += 1; },
  });
  const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));

  assert.equal(changed, true);
  assert.equal(unchanged, false);
  assert.equal(restarts, 1);
  assert.equal(saved.gewePublicCallbackBaseUrl, 'https://steady-personal-wechat.trycloudflare.com');
  assert.equal(saved.preserveMe, 'unchanged');
});
