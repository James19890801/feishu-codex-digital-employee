import assert from 'node:assert/strict';

const ui = await import('./config-ui.js').catch(() => ({}));

assert.equal(
  typeof ui.formatAssistantValue,
  'function',
  'formatAssistantValue must exist before the configuration preview is rendered',
);
assert.equal(typeof ui.assistantRequestHeaders, 'function');
assert.equal(typeof ui.planCanApply, 'function');
assert.equal(typeof ui.rollbackConfirmation, 'function');
assert.equal(typeof ui.runtimeCanSelect, 'function');
assert.equal(typeof ui.runtimeStatusLabel, 'function');
assert.equal(typeof ui.channelRequestHeaders, 'function');
assert.equal(typeof ui.channelSubmitLabel, 'function');
assert.equal(typeof ui.channelNeedsCredential, 'function');
assert.equal(typeof ui.wechatPocRequestHeaders, 'function');

assert.equal(ui.formatAssistantValue(3000), '3000');
assert.equal(ui.formatAssistantValue('short replies'), 'short replies');
assert.equal(
  ui.formatAssistantValue({ enabled: true }),
  '{\n  "enabled": true\n}',
);

assert.deepEqual(ui.assistantRequestHeaders('config-plan', 'session-token'), {
  'Content-Type': 'application/json',
  'X-Dashboard-Action': 'config-plan',
  'X-Dashboard-Session': 'session-token',
});

assert.equal(ui.planCanApply({ changes: [{ target: 'config' }] }), true);
assert.equal(ui.planCanApply({ changes: [] }), false);
assert.equal(ui.planCanApply(null), false);
assert.equal(ui.rollbackConfirmation('snapshot-1234'), 'ROLLBACK snapshot-1234');
assert.equal(ui.runtimeCanSelect({ id: 'qoder', available: true }, 'codex'), true);
assert.equal(ui.runtimeCanSelect({ id: 'qoder', available: false }, 'codex'), false);
assert.equal(ui.runtimeCanSelect({ id: 'codex', available: true }, 'codex'), false);
assert.equal(ui.runtimeStatusLabel({ installed: false, available: false }), '未安装');
assert.equal(ui.runtimeStatusLabel({ installed: true, available: false }), '仅检测到应用');
assert.equal(ui.runtimeStatusLabel({ installed: true, available: true }), '可用');
assert.deepEqual(ui.channelRequestHeaders('session-token'), {
  'Content-Type': 'application/json',
  'X-Dashboard-Action': 'channel-config',
  'X-Dashboard-Session': 'session-token',
});
assert.deepEqual(ui.wechatPocRequestHeaders('wechat-poc-control', 'session-token'), {
  'Content-Type': 'application/json',
  'X-Dashboard-Action': 'wechat-poc-control',
  'X-Dashboard-Session': 'session-token',
});
assert.throws(() => ui.wechatPocRequestHeaders('restart', 'session-token'), /unsupported/i);
assert.equal(ui.channelSubmitLabel({ enabled: true }), '保存并连接');
assert.equal(ui.channelSubmitLabel({ enabled: false }), '保存配置');
assert.equal(ui.channelSubmitLabel({ protected: true }), '主通道受保护');
assert.equal(ui.channelNeedsCredential({ credentialStored: false }, ''), true);
assert.equal(ui.channelNeedsCredential({ credentialStored: true }, ''), false);
assert.equal(ui.channelNeedsCredential({ credentialStored: false }, 'new-secret'), false);
assert.equal(ui.channelNeedsCredential({ credentialStored: true, botId: 'bot-old' }, '', 'bot-new'), true);
assert.equal(ui.channelNeedsCredential({ credentialStored: true, appId: 'app-old' }, '', 'app-old'), false);

console.log('CONFIG_UI_TEST_OK');
