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

console.log('CONFIG_UI_TEST_OK');
