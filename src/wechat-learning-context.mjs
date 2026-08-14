import { createHash } from 'node:crypto';

const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

function boundedText(value, limit) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, limit);
}

function chatroomIdFromConversation(conversation) {
  if (conversation?.channel !== 'wechat' || conversation?.chatType !== 'group') return '';
  const match = String(conversation?.chatId || '').match(/^wechat:group:(.+@chatroom)$/);
  const chatroomId = boundedText(match?.[1], 500);
  return chatroomId.endsWith('@chatroom') ? chatroomId : '';
}

function anonymousConversationId(chatroomId) {
  return `conversation_${createHash('sha256').update(String(chatroomId)).digest('hex').slice(0, 12)}`;
}

async function mapWithConcurrency(values, limit, operation) {
  const results = new Map();
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, Number(limit) || 1), values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        const value = values[index];
        results.set(value, await operation(value));
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function enrichWeChatLearningContext(conversations, {
  state,
  lookupGroup,
  nowMs = Date.now(),
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  maxConcurrency = 4,
} = {}) {
  const source = Array.isArray(conversations) ? conversations : [];
  if (!state?.get || !state?.set || typeof lookupGroup !== 'function') {
    return source.map(conversation => ({ ...conversation }));
  }

  const chatroomIds = [...new Set(source.map(chatroomIdFromConversation).filter(Boolean))];
  const groupNames = await mapWithConcurrency(chatroomIds, maxConcurrency, async chatroomId => {
    const cached = state.get('wechat-learning-group', chatroomId, null);
    const fetchedAtMs = Number(cached?.fetchedAtMs || 0);
    const cachedName = boundedText(cached?.groupName, 200);
    if (cachedName && fetchedAtMs > 0 && nowMs - fetchedAtMs < cacheTtlMs) return cachedName;

    try {
      const info = await lookupGroup(chatroomId);
      const groupName = boundedText(info?.nickName, 200);
      if (!groupName) return '';
      state.set('wechat-learning-group', chatroomId, { groupName, fetchedAtMs: nowMs });
      return groupName;
    } catch (error) {
      state.audit?.('wechat_learning_group_lookup_failed', {
        detail: {
          conversation: anonymousConversationId(chatroomId),
          errorType: boundedText(error?.name || 'Error', 80),
        },
      });
      return '';
    }
  });

  return source.map(conversation => {
    const chatroomId = chatroomIdFromConversation(conversation);
    const groupName = groupNames.get(chatroomId);
    return groupName ? { ...conversation, groupName } : { ...conversation };
  });
}
