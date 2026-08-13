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
assert.equal(typeof ui.dailyLearningRequestHeaders, 'function');

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
assert.equal(ui.runtimeStatusLabel({ installed: false, available: false }), 'Not installed');
assert.equal(ui.runtimeStatusLabel({ installed: true, available: false }), 'Application detected only');
assert.equal(ui.runtimeStatusLabel({ installed: true, available: true }), 'Online');
assert.equal(ui.runtimeStatusLabel({ installed: false, available: false }, 'zh'), '未安装');
assert.deepEqual(ui.channelRequestHeaders('session-token'), {
  'Content-Type': 'application/json',
  'X-Dashboard-Action': 'channel-config',
  'X-Dashboard-Session': 'session-token',
});
assert.deepEqual(ui.dailyLearningRequestHeaders('session-token'), {
  'Content-Type': 'application/json',
  'X-Dashboard-Action': 'learning-run',
  'X-Dashboard-Session': 'session-token',
});
assert.equal(ui.channelSubmitLabel({ enabled: true }), 'Save & connect');
assert.equal(ui.channelSubmitLabel({ enabled: false }), 'Save configuration');
assert.equal(ui.channelSubmitLabel({ protected: true }), 'PRIMARY PATH PROTECTED');
assert.equal(ui.channelSubmitLabel({ enabled: true }, 'zh'), '保存并连接');
assert.equal(ui.channelNeedsCredential({ credentialStored: false }, ''), true);
assert.equal(ui.channelNeedsCredential({ credentialStored: true }, ''), false);
assert.equal(ui.channelNeedsCredential({ credentialStored: false }, 'new-secret'), false);
assert.equal(ui.channelNeedsCredential({ credentialStored: true, botId: 'bot-old' }, '', 'bot-new'), true);
assert.equal(ui.channelNeedsCredential({ credentialStored: true, appId: 'app-old' }, '', 'app-old'), false);

console.log('CONFIG_UI_TEST_OK');
