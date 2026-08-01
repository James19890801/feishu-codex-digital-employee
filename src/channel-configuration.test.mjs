import assert from 'node:assert/strict';

const channelConfiguration = await import('./channel-configuration.mjs').catch(() => ({}));

assert.equal(typeof channelConfiguration.channelConfigurationView, 'function');
assert.equal(typeof channelConfiguration.normalizeChannelConfigurationRequest, 'function');
assert.equal(typeof channelConfiguration.channelCredentialTarget, 'function');
assert.equal(typeof channelConfiguration.channelConnectionReport, 'function');

const configuration = {
  feishuAppId: 'cli_0123456789abcdef',
  dingtalkEnabled: false,
  dingtalkProfile: 'desktop-api.dingtalk',
  wecomEnabled: true,
  wecomBotId: 'bot-production-01',
  wecomKeychainService: 'aipro-wecom-bot',
  geweEnabled: false,
  geweAppId: 'wxid_example',
  geweKeychainService: 'aipro-gewe',
  gewePublicCallbackBaseUrl: 'https://callback.example.com/aipro',
  geweMentionNames: ['James', '詹老师'],
};

const view = channelConfiguration.channelConfigurationView(configuration, {
  wecom: true,
  wechat: false,
});
assert.deepEqual(Object.keys(view), ['feishu', 'dingtalk', 'wecom', 'wechat']);
assert.equal(view.feishu.protected, true);
assert.equal(view.feishu.enabled, true);
assert.match(view.feishu.identity, /^cli_\*+/);
assert.equal(view.dingtalk.profile, 'desktop-api.dingtalk');
assert.equal(view.wecom.credentialStored, true);
assert.equal(view.wechat.credentialStored, false);
assert.deepEqual(view.wechat.mentionNames, ['James', '詹老师']);
assert.doesNotMatch(JSON.stringify(view), /secret|token-value|password/i);

assert.throws(
  () => channelConfiguration.normalizeChannelConfigurationRequest('feishu', { enabled: false }),
  /protected/i,
);

assert.deepEqual(
  channelConfiguration.normalizeChannelConfigurationRequest('dingtalk', {
    enabled: true,
    profile: 'desktop-api.dingtalk',
  }),
  {
    channel: 'dingtalk',
    changes: { dingtalkEnabled: true, dingtalkProfile: 'desktop-api.dingtalk' },
    credential: null,
  },
);

assert.deepEqual(
  channelConfiguration.normalizeChannelConfigurationRequest('wecom', {
    enabled: true,
    botId: 'bot-production-01',
    credential: 'private-secret-value',
  }),
  {
    channel: 'wecom',
    changes: { wecomEnabled: true, wecomBotId: 'bot-production-01' },
    credential: 'private-secret-value',
  },
);

assert.deepEqual(
  channelConfiguration.normalizeChannelConfigurationRequest('wechat', {
    enabled: true,
    appId: 'wxid_example',
    publicCallbackBaseUrl: 'https://callback.example.com/aipro/',
    mentionNames: 'James, 詹老师\nJames',
    credential: 'gewe-private-token',
  }),
  {
    channel: 'wechat',
    changes: {
      geweEnabled: true,
      geweAppId: 'wxid_example',
      gewePublicCallbackBaseUrl: 'https://callback.example.com/aipro',
      geweMentionNames: ['James', '詹老师'],
    },
    credential: 'gewe-private-token',
  },
);

assert.throws(
  () => channelConfiguration.normalizeChannelConfigurationRequest('wechat', {
    enabled: true,
    appId: 'wxid_example',
    publicCallbackBaseUrl: 'http://callback.example.com',
  }),
  /https/i,
);
assert.throws(
  () => channelConfiguration.normalizeChannelConfigurationRequest('wecom', {
    enabled: true,
    botId: '',
  }),
  /bot id/i,
);
assert.throws(
  () => channelConfiguration.normalizeChannelConfigurationRequest('wechat', {
    enabled: true,
    appId: 'wxid_example',
    publicCallbackBaseUrl: '',
  }),
  /callback/i,
);
assert.throws(
  () => channelConfiguration.normalizeChannelConfigurationRequest('unknown', {}),
  /unknown/i,
);

assert.deepEqual(channelConfiguration.channelCredentialTarget('wecom', configuration), {
  service: 'aipro-wecom-bot',
  account: 'bot-production-01',
  label: 'WeCom Bot Secret',
});
assert.deepEqual(channelConfiguration.channelCredentialTarget('wechat', configuration), {
  service: 'aipro-gewe',
  account: 'wxid_example',
  label: 'GeWe API Token',
});
assert.equal(channelConfiguration.channelCredentialTarget('dingtalk', configuration), null);

const feishuReport = channelConfiguration.channelConnectionReport('feishu', {
  process: { alive: true },
  polling: { healthy: true },
  websocket: { active: true },
});
assert.equal(feishuReport.ok, true);
assert.deepEqual(feishuReport.checks.map(item => item.label), [
  '主进程', '用户消息轮询', 'WebSocket 辅助监听',
]);

const wecomReport = channelConfiguration.channelConnectionReport('wecom', {
  channels: {
    wecom: {
      enabled: true,
      installed: true,
      configured: true,
      authenticated: true,
      connected: false,
      lastError: { error: 'handshake timeout' },
    },
  },
});
assert.equal(wecomReport.ok, false);
assert.equal(wecomReport.state, 'failed');
assert.equal(wecomReport.checks.at(-1).passed, false);
assert.match(wecomReport.detail, /handshake timeout/);

const disabledReport = channelConfiguration.channelConnectionReport('wechat', {
  channels: { wechat: { enabled: false, installed: true, configured: false } },
});
assert.equal(disabledReport.ok, true);
assert.equal(disabledReport.state, 'disabled');

console.log('CHANNEL_CONFIGURATION_TEST_OK');
