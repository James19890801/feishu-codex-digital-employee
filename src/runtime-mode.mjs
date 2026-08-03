export function runtimeMode(configuration = {}) {
  const feishuEnabled = configuration.feishuEnabled !== false;
  return {
    feishuEnabled,
    primaryChannel: feishuEnabled
      ? 'feishu'
      : (configuration.dingtalkEnabled === true ? 'dingtalk' : 'none'),
    pollingRequired: feishuEnabled,
    websocketRequired: feishuEnabled,
  };
}

export function validateFeishuConfiguration(configuration = {}) {
  if (configuration.feishuEnabled === false) return;
  if (!configuration.feishuAppId) throw new Error('config.local.json 缺少 feishuAppId');
  if (!configuration.ownerOpenId) throw new Error('config.local.json 缺少 ownerOpenId');
  if (!/^cli_[0-9a-fA-F]{16}$/.test(configuration.feishuAppId)) {
    throw new Error('feishuAppId 格式无效');
  }
  if (!/^ou_[A-Za-z0-9]+$/.test(configuration.ownerOpenId)) {
    throw new Error('ownerOpenId 格式无效');
  }
}

export function validateDingTalkConfiguration(configuration = {}) {
  const transport = String(configuration.dingtalkTransport || 'event-stream').trim();
  if (!['event-stream', 'wukong-polling'].includes(transport)) {
    throw new Error('dingtalkTransport 只能是 event-stream 或 wukong-polling');
  }
  const ownerOpenId = String(configuration.dingtalkOwnerOpenId || '').trim();
  if (ownerOpenId && !/^[A-Za-z0-9_-]{8,256}$/.test(ownerOpenId)) {
    throw new Error('dingtalkOwnerOpenId 格式无效');
  }
  if (configuration.dingtalkEnabled === true
    && configuration.multicaEnabled === true
    && !ownerOpenId) {
    throw new Error('启用钉钉 Multica Owner 写入时必须填写 dingtalkOwnerOpenId');
  }
}
