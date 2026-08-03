import assert from 'node:assert/strict';
import { MacOsWeChatUiAdapter } from './macos-ui-adapter.mjs';

const calls = [];
let telemetryCursor = 10;
const telemetry = {
  cursor() { return telemetryCursor; },
  async waitForSelection({ title, afterCursor }) {
    assert.equal(title, '测试');
    assert.equal(afterCursor, 10);
    telemetryCursor = 11;
    return {
      cursor: 11,
      itemName: '测试',
      itemType: 3,
      moduleType: 2,
      clickedAt: Date.now(),
    };
  },
  async waitForSendReceipt({ afterCursor }) {
    assert.equal(afterCursor, 11);
    telemetryCursor = 12;
    return { cursor: 12, chatName: '123456789@chatroom', wordCount: 4 };
  },
};
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
  const action = args[3];
  if (action === 'scan-notifications') {
    return {
      stdout: JSON.stringify({
        ok: true,
        available: true,
        observations: [{
          sourceMessageId: 'notification-1',
          conversationTitle: '测试',
          conversationKind: 'direct',
          senderName: '测试',
          direction: 'incoming',
          contentType: 'text',
          text: '你好',
          observedAt: '2026-08-01T03:00:00.000Z',
        }],
      }),
      stderr: '',
    };
  }
  if (action === 'send') {
    return { stdout: JSON.stringify({ ok: true, sent: true }), stderr: '' };
  }
  return {
    stdout: JSON.stringify({ ok: true, available: true, action }),
    stderr: '',
  };
};
const adapter = new MacOsWeChatUiAdapter({
  scriptPath: '/tmp/wechat-poc-ui.jxa',
  helperPath: '/tmp/wechat-poc-vision',
  runner,
  telemetry,
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
assert.equal(calls.at(-1).args[3], 'scan-notifications');
assert.equal(calls.some(call => call.command === '/usr/sbin/screencapture'), false);

const resolved = await adapter.resolveTarget({
  chatId: 'wechat-poc:group:abc',
  conversationKind: 'group',
  conversationTitle: '测试',
});
assert.equal(resolved.matched, true);
assert.equal(resolved.proof.windowId, 7);
assert.equal(resolved.proof.itemType, 3);
assert.equal(resolved.proof.moduleType, 2);
assert.equal(resolved.proof.conversationKind, 'group');
assert.ok(calls.some(call => call.command === '/usr/bin/osascript' && call.args[3] === 'search-target'));
await adapter.insertText({ nonce: 'proof' }, '安全回复');
assert.equal(calls.at(-1).args[3], 'insert-text');
const sent = await adapter.send(resolved.proof);
assert.equal(calls.at(-1).args[3], 'send');
assert.equal(sent.sent, true);
assert.equal(sent.receipt.chatName, '123456789@chatroom');
await adapter.verifySent({ nonce: 'proof' }, 'hash');
assert.equal(calls.at(-1).args[3], 'verify-sent');

const unsafeSelection = new MacOsWeChatUiAdapter({
  scriptPath: '/tmp/wechat-poc-ui.jxa',
  helperPath: '/tmp/wechat-poc-vision',
  runner,
  telemetry: {
    cursor: () => 20,
    waitForSelection: async () => ({
      cursor: 21,
      itemName: '测试',
      itemType: 4,
      moduleType: 0,
      clickedAt: Date.now(),
    }),
  },
});
const rejectedArticle = await unsafeSelection.resolveTarget({
  conversationKind: 'group',
  conversationTitle: '测试',
});
assert.equal(rejectedArticle.matched, false);
assert.equal(rejectedArticle.reason, 'unsafe_search_result');

const wrongKind = new MacOsWeChatUiAdapter({
  scriptPath: '/tmp/wechat-poc-ui.jxa',
  helperPath: '/tmp/wechat-poc-vision',
  runner,
  telemetry: {
    cursor: () => 30,
    waitForSendReceipt: async () => ({
      cursor: 31,
      chatName: 'direct-contact',
      wordCount: 4,
    }),
  },
});
const rejectedReceipt = await wrongKind.send({
  conversationKind: 'group',
  telemetryCursor: 30,
});
assert.equal(rejectedReceipt.sent, false);
assert.equal(rejectedReceipt.uncertain, true);
assert.equal(rejectedReceipt.error, 'send_destination_kind_mismatch');

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
