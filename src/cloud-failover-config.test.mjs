import assert from 'node:assert/strict';
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

console.log('CLOUD_FAILOVER_CONFIG_TEST_OK');
