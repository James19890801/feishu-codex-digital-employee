import assert from 'node:assert/strict';
import { MacOsWeChatUiAdapter } from './macos-ui-adapter.mjs';

const calls = [];
const visionAnalysis = {
  ok: true,
  words: [
    { text: '测试', x: 0.16, y: 0.68, width: 0.04, height: 0.02 },
    { text: '你好', x: 0.16, y: 0.64, width: 0.04, height: 0.02 },
    { text: '测试', x: 0.40, y: 0.94, width: 0.04, height: 0.02 },
  ],
  redBadges: [{ x: 0.113, y: 0.68, width: 0.018, height: 0.025 }],
};
const runner = async (command, args, options) => {
  calls.push({ command, args, options });
  if (command === '/tmp/wechat-poc-vision') {
    if (args[0] === 'window-info') {
      return { stdout: JSON.stringify({ ok: true, windowId: 7, x: 100, y: 100, width: 880, height: 640 }), stderr: '' };
    }
    if (args[0] === 'click') return { stdout: JSON.stringify({ ok: true }), stderr: '' };
    return { stdout: JSON.stringify(visionAnalysis), stderr: '' };
  }
  if (command === '/usr/sbin/screencapture') return { stdout: '', stderr: '' };
  return {
    stdout: JSON.stringify({ ok: true, available: true, action: args[3] }),
    stderr: '',
  };
};
const adapter = new MacOsWeChatUiAdapter({
  scriptPath: '/tmp/wechat-poc-ui.jxa',
  helperPath: '/tmp/wechat-poc-vision',
  runner,
});

const probe = await adapter.probe();
assert.equal(probe.available, true);
assert.equal(calls[0].command, '/usr/bin/osascript');
assert.deepEqual(calls[0].args.slice(0, 3), ['-l', 'JavaScript', '/tmp/wechat-poc-ui.jxa']);
assert.equal(calls[0].args[3], 'probe');
assert.deepEqual(JSON.parse(Buffer.from(calls[0].args[4], 'base64url').toString()), {
  helperPath: '/tmp/wechat-poc-vision',
});
assert.equal(calls[0].options.timeoutMs, 8_000);

const observations = await adapter.scan({ boundaryAt: '2026-08-01T03:00:00.000Z' });
assert.equal(observations[0].conversationTitle, '测试');
assert.equal(observations[0].text, '你好');
assert.ok(calls.some(call => call.command === '/usr/sbin/screencapture'));

const resolved = await adapter.resolveTarget({ chatId: 'wechat-poc:user:abc', conversationTitle: '测试' });
assert.equal(resolved.matched, true);
assert.equal(resolved.proof.windowId, 7);
assert.ok(calls.some(call => call.command === '/tmp/wechat-poc-vision' && call.args[0] === 'click'));
await adapter.insertText({ nonce: 'proof' }, '安全回复');
assert.equal(calls.at(-1).args[3], 'insert-text');
await adapter.send({ nonce: 'proof' });
assert.equal(calls.at(-1).args[3], 'send');
await adapter.verifySent({ nonce: 'proof' }, 'hash');
assert.equal(calls.at(-1).args[3], 'verify-sent');

await assert.rejects(
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
