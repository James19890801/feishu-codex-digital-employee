import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeCloudFailoverConfig } from './cloud-failover-config.mjs';

assert.deepEqual(normalizeCloudFailoverConfig({}), {
  cloudFailoverEnabled: false,
  cloudFailoverBaseUrl: '',
  cloudFailoverNodeId: '',
  cloudFailoverHeartbeatMs: 30_000,
  cloudFailoverMissThreshold: 3,
  cloudFailoverRecoveryThreshold: 3,
  cloudFailoverLocalAttempts: 3,
  cloudFailoverMaxPromptChars: 24_000,
  cloudFailoverKeychainService: 'james-cloud-failover',
  cloudFailoverKeychainAccount: 'hmac-secret',
});

assert.deepEqual(normalizeCloudFailoverConfig({
  cloudFailoverEnabled: true,
  cloudFailoverBaseUrl: 'https://failover.example.com/',
  cloudFailoverNodeId: 'node-123',
}), {
  cloudFailoverEnabled: true,
  cloudFailoverBaseUrl: 'https://failover.example.com',
  cloudFailoverNodeId: 'node-123',
  cloudFailoverHeartbeatMs: 30_000,
  cloudFailoverMissThreshold: 3,
  cloudFailoverRecoveryThreshold: 3,
  cloudFailoverLocalAttempts: 3,
  cloudFailoverMaxPromptChars: 24_000,
  cloudFailoverKeychainService: 'james-cloud-failover',
  cloudFailoverKeychainAccount: 'hmac-secret',
});

for (const [input, pattern] of [
  [{ cloudFailoverEnabled: true, cloudFailoverBaseUrl: 'http://x.test', cloudFailoverNodeId: 'node-1' }, /https/i],
  [{ cloudFailoverEnabled: true, cloudFailoverBaseUrl: 'https://x.test?a=1', cloudFailoverNodeId: 'node-1' }, /origin/i],
  [{ cloudFailoverEnabled: true, cloudFailoverBaseUrl: 'https://x.test', cloudFailoverNodeId: '' }, /node/i],
  [{ cloudFailoverHeartbeatMs: 9_999 }, /heartbeat/i],
  [{ cloudFailoverMissThreshold: 1 }, /miss/i],
  [{ cloudFailoverRecoveryThreshold: 11 }, /recovery/i],
  [{ cloudFailoverLocalAttempts: 4 }, /attempt/i],
  [{ cloudFailoverMaxPromptChars: 40_001 }, /prompt/i],
]) {
  assert.throws(() => normalizeCloudFailoverConfig(input), pattern);
}

const fixtureRoot = await mkdtemp(join(tmpdir(), 'aipros-online-first-failover-config-'));
try {
  const fixture = JSON.parse(await readFile(new URL('../config.example.json', import.meta.url), 'utf8'));
  Object.assign(fixture, {
    aiRuntime: 'online-first',
    aiLabAgentId: 'agt_test123',
    aiLabApiKey: 'ak-test-secret',
    aiLabWorkNo: '384351',
    cloudFailoverEnabled: true,
    cloudFailoverBaseUrl: 'https://failover.example.com',
    cloudFailoverNodeId: 'node-online-first-test',
  });
  const fixturePath = join(fixtureRoot, 'config.json');
  await writeFile(fixturePath, `${JSON.stringify(fixture)}\n`, { mode: 0o600 });
  const loaded = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { config } = await import(${JSON.stringify(new URL('./config.mjs', import.meta.url).href)});
    if (config.aiRuntime !== 'online-first' || config.cloudFailoverEnabled !== true) process.exit(2);
  `], {
    encoding: 'utf8',
    env: { ...process.env, DIGITAL_EMPLOYEE_CONFIG: fixturePath },
  });
  assert.equal(loaded.status, 0, loaded.stderr || loaded.stdout);
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}

console.log('CLOUD_FAILOVER_CONFIG_TEST_OK');
