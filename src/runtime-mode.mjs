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
