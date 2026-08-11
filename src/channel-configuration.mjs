const CHANNELS = new Set(['feishu', 'dingtalk', 'wecom', 'wechat']);

function maskedIdentity(value) {
  const source = String(value || '');
  if (!source) return '未配置';
  const prefix = source.includes('_') ? `${source.split('_', 1)[0]}_` : source.slice(0, 3);
  return `${prefix}${'*'.repeat(Math.max(8, source.length - prefix.length))}`;
}

function requiredString(value, label, { maxLength = 200 } = {}) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} is required and must be at most ${maxLength} characters`);
  }
  return normalized;
}

function optionalProfile(value) {
  const normalized = String(value || '').trim();
  if (normalized.length > 200 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error('DingTalk profile must be at most 200 characters');
  }
  return normalized;
}

function optionalCredential(value) {
  const credential = String(value || '');
  if (!credential) return null;
  if (credential.length < 8 || credential.length > 4096 || /[\r\n\u0000]/.test(credential)) {
    throw new Error('Credential must contain 8 to 4096 characters without line breaks');
  }
  return credential;
}

function callbackUrl(value, { required }) {
  const source = String(value || '').trim();
  if (!source) {
    if (required) throw new Error('A public HTTPS callback URL is required when WeChat is enabled');
    return '';
  }
  let url;
  try {
    url = new URL(source);
  } catch {
    throw new Error('The callback must be a valid HTTPS URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('The callback must be an HTTPS URL without credentials, query, or fragment');
  }
  return url.href.replace(/\/$/, '');
}

function mentionNames(value) {
  const values = Array.isArray(value)
    ? value
    : String(value || '').split(/[,，\n]/);
  const normalized = [...new Set(values.map(item => String(item).trim()).filter(Boolean))];
  if (normalized.length > 10 || normalized.some(item => item.length > 100 || /[\u0000-\u001f\u007f]/.test(item))) {
    throw new Error('Mention names must contain at most 10 names of 100 characters each');
  }
  return normalized;
}

export function channelConfigurationView(configuration, credentialStates = {}) {
  return {
    feishu: {
      id: 'feishu',
      protected: true,
      enabled: configuration.feishuEnabled !== false,
      identity: configuration.feishuEnabled === false
        ? '未配置'
        : maskedIdentity(configuration.feishuAppId),
      credentialStored: configuration.feishuEnabled !== false,
    },
    dingtalk: {
      id: 'dingtalk',
      protected: false,
      enabled: configuration.dingtalkEnabled === true,
      profile: String(configuration.dingtalkProfile || ''),
      credentialStored: true,
    },
    wecom: {
      id: 'wecom',
      protected: false,
      enabled: configuration.wecomEnabled === true,
      botId: String(configuration.wecomBotId || ''),
      credentialStored: credentialStates.wecom === true,
    },
    wechat: {
      id: 'wechat',
      protected: false,
      enabled: configuration.geweEnabled === true,
      appId: String(configuration.geweAppId || ''),
      publicCallbackBaseUrl: String(configuration.gewePublicCallbackBaseUrl || ''),
      mentionNames: Array.isArray(configuration.geweMentionNames)
        ? [...configuration.geweMentionNames]
        : [],
      credentialStored: credentialStates.wechat === true,
    },
  };
}

export function normalizeChannelConfigurationRequest(channel, payload = {}) {
  if (!CHANNELS.has(channel)) throw new Error('Unknown IM channel');
  if (channel === 'feishu') throw new Error('Feishu is the protected primary channel and cannot be changed here');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Channel configuration must be an object');
  }
  const enabled = payload.enabled === true;
  if (channel === 'dingtalk') {
    return {
      channel,
      changes: {
        dingtalkEnabled: enabled,
        dingtalkProfile: optionalProfile(payload.profile),
      },
      credential: null,
    };
  }
  if (channel === 'wecom') {
    const botId = enabled
      ? requiredString(payload.botId, 'WeCom Bot ID')
      : String(payload.botId || '').trim().slice(0, 200);
    return {
      channel,
      changes: { wecomEnabled: enabled, wecomBotId: botId },
      credential: optionalCredential(payload.credential),
    };
  }
  const appId = enabled
    ? requiredString(payload.appId, 'GeWe App ID')
    : String(payload.appId || '').trim().slice(0, 200);
  return {
    channel,
    changes: {
      geweEnabled: enabled,
      geweAppId: appId,
      gewePublicCallbackBaseUrl: callbackUrl(payload.publicCallbackBaseUrl, { required: enabled }),
      geweMentionNames: mentionNames(payload.mentionNames),
    },
    credential: optionalCredential(payload.credential),
  };
}

export function channelCredentialTarget(channel, configuration) {
  if (channel === 'wecom') {
    return {
      service: String(configuration.wecomKeychainService || 'aipro-wecom-bot'),
      account: String(configuration.wecomBotId || ''),
      label: 'WeCom Bot Secret',
    };
  }
  if (channel === 'wechat') {
    return {
      service: String(configuration.geweKeychainService || 'aipro-gewe'),
      account: String(configuration.geweAppId || ''),
      label: 'GeWe API Token',
    };
  }
  return null;
}

function check(label, passed, detail = '') {
  return { label, passed: Boolean(passed), detail: String(detail || '') };
}

export function channelConnectionReport(channel, status) {
  if (!CHANNELS.has(channel)) throw new Error('Unknown IM channel');
  if (channel === 'feishu') {
    const enabled = status?.channels?.feishu?.enabled !== false;
    if (!enabled) {
      return {
        channel,
        ok: true,
        state: 'disabled',
        checks: [check('通道开关', true, '当前机器未启用飞书')],
        detail: '飞书通道当前未启用',
      };
    }
    const checks = [
      check('主进程', status?.process?.alive),
      check('用户消息轮询', status?.polling?.healthy),
      check('WebSocket 辅助监听', status?.websocket?.active),
    ];
    return {
      channel,
      ok: checks.every(item => item.passed),
      state: checks.every(item => item.passed) ? 'connected' : 'failed',
      checks,
      detail: String(status?.polling?.lastError?.error || ''),
    };
  }
  const current = status?.channels?.[channel] || {};
  if (!current.enabled) {
    return {
      channel,
      ok: true,
      state: 'disabled',
      checks: [check('通道开关', true, '当前未启用，不影响飞书主通道')],
      detail: '通道当前未启用',
    };
  }
  const checks = [
    check('本机运行时', current.installed),
    check('必要配置', current.configured),
    check('身份认证', current.authenticated),
    check('实时连接', current.connected),
  ];
  return {
    channel,
    ok: checks.every(item => item.passed),
    state: checks.every(item => item.passed) ? 'connected' : 'failed',
    checks,
    detail: String(current.lastError?.error || ''),
  };
}
