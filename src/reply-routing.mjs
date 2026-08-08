const MAX_REPLY_MENTIONS = 20;

function normalizeSenderIds(values = []) {
  return [...new Set(values
    .map(value => String(value || '').trim())
    .filter(Boolean))]
    .slice(0, MAX_REPLY_MENTIONS);
}

export function createReplyContext({ message, senderId } = {}) {
  return {
    chatId: String(message?.chat_id || '').trim(),
    chatType: String(message?.chat_type || '').trim(),
    senderIds: normalizeSenderIds([senderId]),
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
