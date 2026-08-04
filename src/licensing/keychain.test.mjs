import assert from 'node:assert/strict';

import {
  KeychainSecretStore,
  LICENSING_KEYCHAIN_SERVICE,
} from './keychain.mjs';

const calls = [];
const values = new Map();
const runner = async (file, args) => {
  calls.push({ file, args: [...args] });
  const account = args[args.indexOf('-a') + 1];
  if (args[0] === 'find-generic-password') {
    if (!values.has(account)) {
      const error = new Error('security failed');
      error.stderr = 'The specified item could not be found in the keychain.';
      throw error;
    }
    return { stdout: `${values.get(account)}\n` };
  }
  if (args[0] === 'add-generic-password') {
    values.set(account, args[args.indexOf('-w') + 1]);
    return { stdout: '' };
  }
  if (args[0] === 'delete-generic-password') {
    values.delete(account);
    return { stdout: '' };
  }
  throw new Error('unexpected command');
};

const store = new KeychainSecretStore({ runner });
assert.equal(await store.get('device-private-key'), null);
await store.put('device-private-key', 'private-value-never-log');
assert.equal(await store.get('device-private-key'), 'private-value-never-log');
await store.remove('device-private-key');
assert.equal(await store.get('device-private-key'), null);

assert.equal(calls.every(call => call.file === '/usr/bin/security'), true);
assert.equal(calls.every(call => call.args.includes(LICENSING_KEYCHAIN_SERVICE)), true);
assert.equal(calls.every(call => !call.args.join(' ').includes(';')), true);

await assert.rejects(
  () => store.put('../bad-account', 'secret'),
  error => error.code === 'invalid_keychain_account'
    && !error.message.includes('secret'),
);
await assert.rejects(
  () => store.put('entitlement', ''),
  error => error.code === 'invalid_keychain_secret',
);

const failing = new KeychainSecretStore({
  runner: async () => {
    const error = new Error('failure private-value-never-log');
    error.stderr = 'private-value-never-log';
    throw error;
  },
});
await assert.rejects(
  () => failing.put('entitlement', 'private-value-never-log'),
  error => error.code === 'keychain_write_failed'
    && !error.message.includes('private-value-never-log'),
);

console.log('LICENSING_KEYCHAIN_TEST_OK');
