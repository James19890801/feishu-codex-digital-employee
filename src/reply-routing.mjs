const MAX_REPLY_MENTIONS = 20;

function normalizeSenderIds(values = []) {
  return [...new Set(values
    .map(value => String(value || '').trim())
    .filter(Boolean))]
    .slice(0, MAX_REPLY_MENTIONS);
}

export function createReplyContext({ message, senderId } = {}) {
  const chatType = String(message?.chat_type || '').trim();
  const senderIds = normalizeSenderIds([senderId]);
  return {
    chatId: String(message?.chat_id || '').trim(),
    chatType,
    senderIds,
    mentionRequired: chatType === 'group' && senderIds.length > 0,
  };
}

export function resolveReplyMentionSenderIds({
  chatId,
  chatType,
  explicitSenderIds = [],
  context = null,
} = {}) {
  if (String(chatType || '').trim() !== 'group') return [];

  const explicit = normalizeSenderIds(explicitSenderIds);
  if (explicit.length) return explicit;

  if (String(context?.chatId || '').trim() !== String(chatId || '').trim()) return [];
  if (String(context?.chatType || '').trim() !== 'group') return [];
  return normalizeSenderIds(context?.senderIds);
}

export function assertRequiredReplyMention({
  chatId,
  chatType,
  senderIds = [],
  context = null,
} = {}) {
  const applies = context?.mentionRequired === true
    && String(context?.chatId || '').trim() === String(chatId || '').trim();
  if (!applies) return false;
  if (String(chatType || '').trim() !== 'group' || normalizeSenderIds(senderIds).length === 0) {
    const error = new Error('Required group reply mention has no valid recipient');
    error.code = 'REQUIRED_REPLY_MENTION_MISSING';
    throw error;
  }
  return true;
}
