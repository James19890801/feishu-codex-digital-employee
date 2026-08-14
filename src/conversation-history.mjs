function speakerLabel(item, { chatType, currentSenderId }) {
  if (item.role !== 'user') return '助理';
  if (chatType === 'group') return `群成员[${item.senderId || '未知'}]`;
  return item.senderId === currentSenderId ? '对方' : '真人本人';
}

export function formatConversationHistory(state, {
  chatId,
  currentSenderId = '',
  excludeSourceMessageId = '',
  chatType = '',
  limit = 50,
} = {}) {
  const effectiveLimit = Math.max(1, Math.min(50, Number(limit) || 50));
  const history = state.chatHistory(
    chatId,
    excludeSourceMessageId ? effectiveLimit + 1 : effectiveLimit,
  )
    .filter(item => item.sourceMessageId !== excludeSourceMessageId)
    .slice(-effectiveLimit);
  if (!history.length) return '（这是当前运行周期内的第一条消息）';
  return history
    .map(item => `${speakerLabel(item, { chatType, currentSenderId })}：${item.content.slice(0, 1800)}`)
    .join('\n');
}
