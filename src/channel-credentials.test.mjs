import assert from 'node:assert/strict';

const credentials = await import('./channel-credentials.mjs').catch(() => ({}));

assert.equal(typeof credentials.keychainCredentialExists, 'function');
assert.equal(typeof credentials.replaceKeychainCredential, 'function');
assert.equal(typeof credentials.readKeychainCredential, 'function');

const target = { service: 'aipro-test', account: 'account-1', label: 'Test Secret' };
assert.equal(await credentials.keychainCredentialExists(target, {
  run: async () => ({ stdout: 'stored-value\n' }),
}), true);
assert.equal(await credentials.keychainCredentialExists(target, {
  run: async () => { throw new Error('not found'); },
}), false);
if (typeof credentials.readKeychainCredential === 'function') {
  assert.equal(await credentials.readKeychainCredential(target, {
    run: async () => ({ stdout: 'stored-value\n' }),
  }), 'stored-value');
}

const calls = [];
const rollbackNew = await credentials.replaceKeychainCredential(target, 'new-private-value', {
  run: async (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === 'find-generic-password') throw new Error('not found');
    return { stdout: '' };
  },
});
assert.equal(typeof rollbackNew, 'function');
assert.equal(calls[1].args[0], 'add-generic-password');
assert.equal(calls[1].args.at(-1), '-w');
assert.equal(calls[1].args.includes('new-private-value'), false);
assert.equal(calls[1].options.input, 'new-private-value\nnew-private-value\n');
await rollbackNew();
assert.equal(calls.at(-1).args[0], 'delete-generic-password');

const restoreCalls = [];
const rollbackExisting = await credentials.replaceKeychainCredential(target, 'replacement-value', {
  run: async (command, args, options) => {
    restoreCalls.push({ command, args, options });
    if (args[0] === 'find-generic-password') return { stdout: 'previous-value\n' };
    return { stdout: '' };
  },
});
await rollbackExisting();
assert.equal(restoreCalls.at(-1).args[0], 'add-generic-password');
assert.equal(restoreCalls.at(-1).options.input, 'previous-value\nprevious-value\n');

await assert.rejects(
  credentials.replaceKeychainCredential(target, 'do-not-leak-me', {
    run: async (command, args) => {
      if (args[0] === 'find-generic-password') throw new Error('not found');
      throw new Error(`failed with ${args.at(-1)}`);
    },
  }),
  error => !String(error.message).includes('do-not-leak-me') && /keychain/i.test(error.message),
);

console.log('CHANNEL_CREDENTIALS_TEST_OK');
