import assert from 'node:assert/strict';

const runtime = await import('./runtime-mode.mjs');

assert.deepEqual(runtime.runtimeMode({ feishuEnabled: false, dingtalkEnabled: true }), {
  feishuEnabled: false,
  primaryChannel: 'dingtalk',
  pollingRequired: false,
  websocketRequired: false,
});

assert.deepEqual(runtime.runtimeMode({}), {
  feishuEnabled: true,
  primaryChannel: 'feishu',
  pollingRequired: true,
  websocketRequired: true,
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
  () => runtime.validateDingTalkConfiguration({
    dingtalkEnabled: true,
    multicaEnabled: false,
    dingtalkTransport: 'wukong-polling',
    dingtalkOwnerOpenId: '',
  }),
  /event-stream.*Wukong|Wukong.*event-stream/,
);
assert.doesNotThrow(() => runtime.validateDingTalkConfiguration({
  dingtalkEnabled: true,
  multicaEnabled: false,
  dingtalkTransport: 'event-stream',
  dingtalkOwnerOpenId: '',
}));
assert.throws(
  () => runtime.validateDingTalkConfiguration({
    dingtalkEnabled: true,
    multicaEnabled: false,
    dingtalkTransport: 'automatic-fallback',
    dingtalkOwnerOpenId: '',
  }),
  /dingtalkTransport/,
);
assert.throws(
  () => runtime.validateDingTalkConfiguration({
    dingtalkEnabled: true,
    multicaEnabled: true,
    dingtalkOwnerOpenId: '',
  }),
  /dingtalkOwnerOpenId/,
);
assert.doesNotThrow(() => runtime.validateDingTalkConfiguration({
  dingtalkEnabled: true,
  multicaEnabled: true,
  dingtalkOwnerOpenId: 'open-id-owner-123',
}));

console.log('RUNTIME_MODE_TEST_OK');
