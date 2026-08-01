export function formatAssistantValue(value) {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'Not set';
  return JSON.stringify(value, null, 2);
}

export function assistantRequestHeaders(action, sessionToken) {
  return {
    'Content-Type': 'application/json',
    'X-Dashboard-Action': action,
    'X-Dashboard-Session': sessionToken,
  };
}

export function planCanApply(plan) {
  return Boolean(plan && Array.isArray(plan.changes) && plan.changes.length);
}

export function rollbackConfirmation(snapshotId) {
  return `ROLLBACK ${snapshotId}`;
}

export function runtimeCanSelect(runtime, selectedId) {
  return Boolean(runtime?.available && runtime.id !== selectedId);
}

export function runtimeStatusLabel(runtime) {
  if (runtime?.available) return '可用';
  if (runtime?.installed) return '仅检测到应用';
  return '未安装';
}

export function channelRequestHeaders(sessionToken) {
  return assistantRequestHeaders('channel-config', sessionToken);
}

export function channelSubmitLabel(channel) {
  if (channel?.protected) return '主通道受保护';
  return channel?.enabled ? '保存并连接' : '保存配置';
}

export function channelNeedsCredential(channel, enteredCredential, requestedIdentity = '') {
  if (String(enteredCredential || '')) return false;
  const storedIdentity = channel?.botId ?? channel?.appId ?? '';
  const identityChanged = requestedIdentity && storedIdentity !== requestedIdentity;
  return channel?.credentialStored !== true || Boolean(identityChanged);
}
