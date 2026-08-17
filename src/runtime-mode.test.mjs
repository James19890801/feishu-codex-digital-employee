import assert from 'node:assert/strict';

const runtime = await import('./runtime-mode.mjs');

assert.deepEqual(runtime.runtimeMode({ feishuEnabled: false, enterpriseChatEnabled: true }), {
  feishuEnabled: false,
  primaryChannel: 'enterpriseChat',
  pollingRequired: false,
  websocketRequired: false,
});

assert.deepEqual(runtime.runtimeMode({}), {
  feishuEnabled: false,
  primaryChannel: 'none',
  pollingRequired: false,
  websocketRequired: false,
});

assert.doesNotThrow(() => runtime.validateFeishuConfiguration({ feishuEnabled: false }));
assert.throws(
  () => runtime.validateFeishuConfiguration({ feishuEnabled: true }),
  /feishuAppId/,
);
assert.throws(
  () => runtime.validateFeishuConfiguration({
    feishuEnabled: true,
    feishuAppId: 'cli_0123456789abcdef',
  }),
  /ownerOpenId/,
);
assert.doesNotThrow(() => runtime.validateFeishuConfiguration({
  feishuEnabled: true,
  feishuAppId: 'cli_0123456789abcdef',
  ownerOpenId: 'ou_abc123',
}));

assert.throws(
  () => runtime.validateEnterpriseChatConfiguration({
    enterpriseChatEnabled: true,
    multicaEnabled: false,
    enterpriseChatTransport: 'legacyBridge-polling',
    enterpriseChatOwnerOpenId: '',
  }),
  /event-stream/u,
);
assert.doesNotThrow(() => runtime.validateEnterpriseChatConfiguration({
  enterpriseChatEnabled: true,
  multicaEnabled: false,
  enterpriseChatTransport: 'event-stream',
  enterpriseChatOwnerOpenId: '',
}));
assert.throws(
  () => runtime.validateEnterpriseChatConfiguration({
    enterpriseChatEnabled: true,
    multicaEnabled: false,
    enterpriseChatTransport: 'automatic-fallback',
    enterpriseChatOwnerOpenId: '',
  }),
  /enterpriseChatTransport/,
);
assert.throws(
  () => runtime.validateEnterpriseChatConfiguration({
    enterpriseChatEnabled: true,
    multicaEnabled: true,
    enterpriseChatOwnerOpenId: '',
  }),
  /enterpriseChatOwnerOpenId/,
);
assert.doesNotThrow(() => runtime.validateEnterpriseChatConfiguration({
  enterpriseChatEnabled: true,
  multicaEnabled: true,
  enterpriseChatOwnerOpenId: 'open-id-owner-123',
}));

console.log('RUNTIME_MODE_TEST_OK');
