function messageTime(message) {
  const raw = String(message?.create_time || '');
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}:00+08:00`
    : raw;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function selectInboundMessages(messages, ownerOpenId) {
  const seen = new Set();
  return (Array.isArray(messages) ? messages : [])
    .filter(message => {
      if (!message?.message_id || seen.has(message.message_id) || message.deleted) return false;
      if (message.sender?.sender_type !== 'user' || message.sender?.id === ownerOpenId) return false;
      if (!['text', 'post'].includes(message.msg_type || 'text')) return false;
      if (message.chat_type === 'group') {
        if (!message.mentions?.some(mention => mention?.id === ownerOpenId)) return false;
      } else if (message.chat_type !== 'p2p') {
        return false;
      }
      seen.add(message.message_id);
      return true;
    })
    .sort((a, b) => messageTime(a) - messageTime(b)
      || String(a.message_position || '').localeCompare(String(b.message_position || ''))
      || a.message_id.localeCompare(b.message_id));
}

export function normalizeSearchMessage(item) {
  return {
    message: {
      message_id: item.message_id,
      chat_id: item.chat_id,
      chat_type: item.chat_type,
      message_type: 'text',
      create_time: String(messageTime(item) || Date.now()),
      content: JSON.stringify({ text: String(item.content || '') }),
      mentions: Array.isArray(item.mentions) ? item.mentions : [],
    },
    sender: {
      sender_type: item.sender?.sender_type || 'user',
      sender_id: { open_id: item.sender?.id || '' },
    },
  };
}

export function toLarkSearchIso(date) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return `${shifted.toISOString().slice(0, 19)}+08:00`;
}

export function buildPollingSearchArgs(chatType, start, end) {
  const args = [
    'im', '+messages-search', '--as', 'user', '--query', '',
    '--chat-type', chatType, '--sender-type', 'user',
    '--start', start, '--end', end,
    '--page-size', '50', '--page-all', '--no-reactions', '--format', 'json',
  ];
  if (chatType === 'group') args.push('--is-at-me');
  return args;
}

export function retryDelayMs(attempts) {
  return Math.min(60_000, 1_000 * (2 ** Math.max(1, Number(attempts) || 1)));
}

export function shouldRetryMessage(attemptNumber, maxAttempts = 3) {
  return Number(attemptNumber) < Number(maxAttempts);
}
