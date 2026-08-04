import assert from 'node:assert/strict';

import { config, validateCoreConfiguration } from '../config.mjs';

assert.equal(typeof config.licensingEnforced, 'boolean');
assert.equal(typeof config.licensingServiceUrl, 'string');
assert.equal(typeof config.licensingPublicKey, 'string');

assert.throws(
  () => validateCoreConfiguration({
    ...config,
    feishuEnabled: true,
    feishuAppId: '',
    ownerOpenId: '',
    allowAllChats: true,
  }),
  /feishuAppId/,
);
assert.doesNotThrow(() => validateCoreConfiguration({
  ...config,
  feishuEnabled: true,
  feishuAppId: 'cli_0123456789abcdef',
  ownerOpenId: 'ou_owner123',
  allowAllChats: true,
}));
assert.doesNotThrow(() => validateCoreConfiguration({
  ...config,
  feishuEnabled: false,
  feishuAppId: '',
  ownerOpenId: '',
  allowAllChats: true,
}));

console.log('LICENSING_CONFIG_TEST_OK');
