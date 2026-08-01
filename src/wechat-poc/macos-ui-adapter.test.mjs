import assert from 'node:assert/strict';
import { MacOsWeChatUiAdapter } from './macos-ui-adapter.mjs';

const calls = [];
const runner = async (command, args, options) => {
  calls.push({ command, args, options });
  return {
    stdout: JSON.stringify({ ok: true, available: true, action: args[3] }),
    stderr: '',
  };
};
const adapter = new MacOsWeChatUiAdapter({
  scriptPath: '/tmp/wechat-poc-ui.jxa',
  runner,
});

const probe = await adapter.probe();
assert.equal(probe.available, true);
assert.equal(calls[0].command, '/usr/bin/osascript');
assert.deepEqual(calls[0].args.slice(0, 3), ['-l', 'JavaScript', '/tmp/wechat-poc-ui.jxa']);
assert.equal(calls[0].args[3], 'probe');
assert.deepEqual(JSON.parse(Buffer.from(calls[0].args[4], 'base64url').toString()), {});
assert.equal(calls[0].options.timeoutMs, 8_000);

await adapter.scan({ boundaryAt: '2026-08-01T03:00:00.000Z' });
assert.equal(calls.at(-1).args[3], 'scan');
assert.equal(
  JSON.parse(Buffer.from(calls.at(-1).args[4], 'base64url').toString()).boundaryAt,
  '2026-08-01T03:00:00.000Z',
);

await adapter.resolveTarget({ chatId: 'wechat-poc:user:abc', conversationTitle: '测试' });
assert.equal(calls.at(-1).args[3], 'resolve-target');
await adapter.insertText({ nonce: 'proof' }, '安全回复');
assert.equal(calls.at(-1).args[3], 'insert-text');
await adapter.send({ nonce: 'proof' });
assert.equal(calls.at(-1).args[3], 'send');
await adapter.verifySent({ nonce: 'proof' }, 'hash');
assert.equal(calls.at(-1).args[3], 'verify-sent');

assert.throws(
  () => adapter.send({ nonce: 'proof', x: 10, y: 10 }),
  /coordinates are forbidden/i,
);

const invalid = new MacOsWeChatUiAdapter({
  scriptPath: '/tmp/wechat-poc-ui.jxa',
  runner: async () => ({ stdout: 'not-json', stderr: '' }),
});
await assert.rejects(() => invalid.probe(), /invalid JSON/i);

const structuredFailure = new MacOsWeChatUiAdapter({
  scriptPath: '/tmp/wechat-poc-ui.jxa',
  runner: async () => ({
    stdout: JSON.stringify({ ok: false, available: false, reason: 'permission_missing' }),
    stderr: '',
  }),
});
const unavailable = await structuredFailure.probe();
assert.equal(unavailable.available, false);
assert.equal(unavailable.reason, 'permission_missing');

console.log('WECHAT_POC_MACOS_UI_ADAPTER_TEST_OK');
