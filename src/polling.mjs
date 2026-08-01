import { matchHumanTakeoverCommand } from './human-takeover.mjs';

function messageTime(message) {
  const raw = String(message?.create_time || '');
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}:00+08:00`
    : raw;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function comparePollingItems(left, right) {
  const leftOwnerActivity = left?.owner_activity === true ? 1 : 0;
  const rightOwnerActivity = right?.owner_activity === true ? 1 : 0;
  if (leftOwnerActivity !== rightOwnerActivity) return rightOwnerActivity - leftOwnerActivity;
  return messageTime(left) - messageTime(right)
    || String(left?.message_position || '').localeCompare(String(right?.message_position || ''))
    || String(left?.message_id || '').localeCompare(String(right?.message_id || ''));
}

export function selectOwnerControlMessages(messages, ownerOpenId) {
  const seen = new Set();
  return (Array.isArray(messages) ? messages : [])
    .filter(message => {
      if (!message?.message_id || seen.has(message.message_id) || message.deleted) return false;
      if (message.sender?.sender_type !== 'user' || message.sender?.id !== ownerOpenId) return false;
      if (!['group', 'p2p'].includes(message.chat_type)) return false;
      if (!['text', 'post'].includes(message.msg_type || 'text')) return false;
      if (!matchHumanTakeoverCommand(message.content)) return false;
      seen.add(message.message_id);
      return true;
    })
    .map(message => ({ ...message, operator_control: true }))
    .sort((a, b) => messageTime(a) - messageTime(b)
      || String(a.message_position || '').localeCompare(String(b.message_position || ''))
      || a.message_id.localeCompare(b.message_id));
}

export function selectOwnerActivityMessages(messages, ownerOpenId) {
  const seen = new Set();
  return (Array.isArray(messages) ? messages : [])
    .filter(message => {
      if (!message?.message_id || seen.has(message.message_id) || message.deleted) return false;
      if (message.sender?.sender_type !== 'user' || message.sender?.id !== ownerOpenId) return false;
      if (!['group', 'p2p'].includes(message.chat_type)) return false;
      if (!['text', 'post'].includes(message.msg_type || 'text')) return false;
      seen.add(message.message_id);
      return true;
    })
    .map(message => ({
      ...message,
      owner_activity: true,
      operator_control: Boolean(matchHumanTakeoverCommand(message.content)),
    }))
    .sort((a, b) => messageTime(a) - messageTime(b)
      || String(a.message_position || '').localeCompare(String(b.message_position || ''))
      || a.message_id.localeCompare(b.message_id));
}

export function selectInboundMessages(messages, ownerOpenId) {
  const seen = new Set();
  return (Array.isArray(messages) ? messages : [])
    .filter(message => {
      if (!message?.message_id || seen.has(message.message_id) || message.deleted) return false;
      if (message.sender?.sender_type !== 'user') return false;
      if (message.sender?.id === ownerOpenId
        && !(message.chat_type === 'p2p' && message.self_chat === true)) return false;
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
  const payload = {
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
  if (item.self_chat === true || item.operator_control === true || item.owner_activity === true) {
    payload.metadata = {
      ...(item.self_chat === true ? { selfChat: true } : {}),
      ...(item.operator_control === true ? { operatorControl: true } : {}),
      ...(item.owner_activity === true ? { ownerActivity: true } : {}),
    };
  }
  return payload;
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

export function buildOwnerControlPollingArgs(ownerOpenId, start, end) {
  return [
    'im', '+messages-search', '--as', 'user', '--query', '',
    '--sender', String(ownerOpenId || ''),
    '--sender-type', 'user',
    '--start', start, '--end', end,
    '--page-size', '50', '--page-all', '--no-reactions', '--format', 'json',
  ];
}

export function buildSelfChatPollingArgs(ownerOpenId, start, end) {
  return [
    'im', '+chat-messages-list', '--as', 'user', '--user-id', ownerOpenId,
    '--start', start, '--end', end,
    '--order', 'asc', '--page-size', '50', '--no-reactions', '--format', 'json',
  ];
}

export function markSelfChatMessages(result) {
  const messages = result?.data?.messages || result?.messages || [];
  return (Array.isArray(messages) ? messages : []).map(message => ({
    ...message,
    chat_type: 'p2p',
    self_chat: true,
  }));
}

export function retryDelayMs(attempts) {
  return Math.min(60_000, 1_000 * (2 ** Math.max(1, Number(attempts) || 1)));
}

export function pollFailureDelayMs(error, failures, {
  baseIntervalMs = 5_000,
  random = Math.random,
} = {}) {
  const detail = [
    String(error?.message || error || ''),
    String(error?.stderr || '').slice(-4_000),
  ].join(' ').toLowerCase();
  const rateLimited = /too many request|rate.?limit|http\s*429|\b429\b/.test(detail);
  const baseDelay = rateLimited
    ? 60_000
    : Math.max(
        Math.max(1_000, Number(baseIntervalMs) || 5_000),
        1_000 * (2 ** Math.min(Math.max(1, Number(failures) || 1), 9)),
      );
  const jitterWindow = rateLimited
    ? 10_000
    : Math.min(30_000, Math.floor(baseDelay * 0.2));
  const jitter = Math.floor(
    Math.max(0, Math.min(1, Number(random()) || 0)) * jitterWindow,
  );
  return Math.min(5 * 60_000, baseDelay + jitter);
}

export function shouldRetryMessage(attemptNumber, maxAttempts = 3) {
  return Number(attemptNumber) < Number(maxAttempts);
}
