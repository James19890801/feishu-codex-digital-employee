import { createHash } from 'node:crypto';

function privateIdentity(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  if (/[,\r\n]/u.test(normalized)) {
    throw new Error('Cloud blacklist identities must not contain commas or newlines');
  }
  return normalized;
}

function sortedUnique(values) {
  return [...new Set(values.map(privateIdentity).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'en'));
}

export function projectDingTalkCloudBlacklist(entries = []) {
  const dingtalkEntries = (Array.isArray(entries) ? entries : [])
    .filter(entry => String(entry?.channel || '').trim().toLowerCase() === 'dingtalk');
  const senderIds = sortedUnique(dingtalkEntries.flatMap(entry => [
    entry?.openId,
    entry?.userId,
    ...(Array.isArray(entry?.ids) ? entry.ids : []),
  ]));
  const chatIds = sortedUnique(dingtalkEntries.flatMap(entry => (
    Array.isArray(entry?.chatIds) ? entry.chatIds : []
  )));
  const digest = createHash('sha256').update(JSON.stringify({ senderIds, chatIds })).digest('hex');
  return {
    senderIds,
    chatIds,
    sourceEntryCount: dingtalkEntries.length,
    senderCount: senderIds.length,
    digest,
  };
}
