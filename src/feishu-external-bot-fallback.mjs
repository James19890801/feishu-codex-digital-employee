export function isExternalChatApiRestriction(error) {
  const detail = [error?.message, error?.stderr, error?.stdout, error]
    .map(value => String(value || ''))
    .join('\n');
  return /(?:"code"\s*:\s*230027\b|\b230027\b)/i.test(detail);
}

export function resolveFeishuChatType(explicitChatType, rememberedChatType) {
  for (const value of [explicitChatType, rememberedChatType]) {
    if (value === 'group' || value === 'p2p') return value;
  }
  return '';
}

export function isExpectedLarkCliResult(result, expectedIdentity = 'user') {
  return result?.ok === true && result?.identity === expectedIdentity;
}

export function shouldSendFeishuP2pAsBot({ chatType, botChat }) {
  return chatType === 'p2p' && botChat === true;
}

export async function discoverBotP2pChats({
  messages,
  ownerOpenId,
  readAsBot,
} = {}) {
  const candidates = (Array.isArray(messages) ? messages : [])
    .filter(item => item?.message_id
      && item?.chat_type === 'p2p'
      && item?.sender?.sender_type === 'user'
      && item?.sender?.id === ownerOpenId)
    .slice(-50);
  if (!candidates.length) return { chatIds: new Set(), error: '' };
  try {
    const result = await readAsBot(candidates.map(item => item.message_id));
    const root = result?.data || result?.result || {};
    const items = root.messages || root.items || [];
    return {
      chatIds: new Set((Array.isArray(items) ? items : [])
        .map(item => String(item?.chat_id || '').trim())
        .filter(Boolean)),
      error: '',
    };
  } catch (error) {
    return {
      chatIds: new Set(),
      error: String(error?.message || error || 'bot p2p discovery failed').slice(0, 1000),
    };
  }
}

export async function sendFeishuTextWithExternalBotFallback({
  chatType,
  sendAsUser,
  sendAsBot,
}) {
  try {
    return await sendAsUser();
  } catch (error) {
    if (chatType !== 'group' || !isExternalChatApiRestriction(error)) throw error;
    return sendAsBot(error);
  }
}
