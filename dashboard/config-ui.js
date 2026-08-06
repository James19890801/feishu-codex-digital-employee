import { channelSubmitText, runtimeStatusText } from './i18n.js';

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

export function runtimeStatusLabel(runtime, locale = 'en') {
  return runtimeStatusText(locale, runtime);
}

export function channelRequestHeaders(sessionToken) {
  return assistantRequestHeaders('channel-config', sessionToken);
}

export function wechatPocRequestHeaders(action, sessionToken) {
  if (!['wechat-poc-control', 'wechat-poc-stop', 'wechat-poc-open'].includes(action)) {
    throw new Error('Unsupported personal WeChat action');
  }
  return assistantRequestHeaders(action, sessionToken);
}

export function dailyLearningRequestHeaders(sessionToken) {
  return assistantRequestHeaders('learning-run', sessionToken);
}

export function channelSubmitLabel(channel, locale = 'en') {
  return channelSubmitText(locale, channel);
}

export function channelNeedsCredential(channel, enteredCredential, requestedIdentity = '') {
  if (String(enteredCredential || '')) return false;
  const storedIdentity = channel?.botId ?? channel?.appId ?? '';
  const identityChanged = requestedIdentity && storedIdentity !== requestedIdentity;
  return channel?.credentialStored !== true || Boolean(identityChanged);
}
