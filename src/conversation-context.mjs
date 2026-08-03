import { createHash } from 'node:crypto';

const MAX_HISTORY_MESSAGES = 30;
const MAX_STYLE_SAMPLES = 8;

function requiredText(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`DingTalk history ${label} is required`);
  return text;
}

export function buildDingTalkHistoryArgs(context = {}, options = {}) {
  const kind = requiredText(context.kind, 'kind');
  const targetId = requiredText(context.targetId, 'target');
  const beforeTime = requiredText(options.beforeTime, 'time');
  const profile = requiredText(options.profile, 'profile');
  if (!['direct', 'group'].includes(kind)) {
    throw new Error(`Unsupported DingTalk history kind: ${kind}`);
  }
  return [
    'chat', 'message', 'list',
    kind === 'direct' ? '--open-dingtalk-id' : '--group', targetId,
    '--time', beforeTime,
    '--direction', 'older',
    '--limit', String(MAX_HISTORY_MESSAGES),
    '--format', 'json',
    '--profile', profile,
    '-y',
  ];
}

function rawMessages(root) {
  const candidates = [
    root?.result?.messages,
    root?.result?.messageList,
    root?.data?.messages,
    root?.data?.messageList,
    root?.messages,
    root?.messageList,
  ];
  return candidates.find(Array.isArray) || [];
}

function messageText(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    const text = value.text ?? value.content ?? value.title;
    if (typeof text === 'string') return text.trim();
  }
  return '';
}

function usableText(text) {
  if (!text) return false;
  return !/^\s*(?:\[(?:图片|文件|视频|语音|合并转发)消息\]|\[文件\]|消息已撤回|该消息已撤回)\s*$/u.test(text);
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  const text = String(value || '').trim();
  if (!text) return 0;
  if (/^\d+$/.test(text)) {
    const number = Number(text);
    return number < 10_000_000_000 ? number * 1000 : number;
  }
  const parsed = Date.parse(text.replace(' ', 'T'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeMessage(raw, { conversationId, ownerIds, ownerNames }) {
  const content = messageText(raw?.content ?? raw?.text ?? raw?.messageContent);
  if (!usableText(content)) return null;
  const senderId = String(
    raw?.senderOpenDingTalkId ?? raw?.senderId ?? raw?.senderUserId ?? raw?.userId ?? '',
  ).trim();
  const senderName = String(raw?.sender ?? raw?.senderName ?? raw?.nickName ?? '').trim();
  const createdAtRaw = raw?.createTime ?? raw?.createdAt ?? raw?.sendTime ?? raw?.timestamp ?? '';
  const createdAtMs = timestamp(createdAtRaw);
  const messageConversationId = String(
    raw?.openConversationId ?? raw?.conversationId ?? conversationId ?? '',
  ).trim();
  if (conversationId && messageConversationId && messageConversationId !== conversationId) return null;
  return {
    messageId: String(raw?.openMessageId ?? raw?.messageId ?? raw?.msgId ?? '').trim(),
    conversationId: messageConversationId || String(conversationId || ''),
    senderId,
    senderName,
    direction: ownerIds.has(senderId) || ownerNames.has(senderName) ? 'owner' : 'counterparty',
    content,
    createdAt: String(createdAtRaw || ''),
    createdAtMs,
  };
}

function fingerprint(message) {
  return createHash('sha256')
    .update(`${message.senderId}\u0000${message.createdAtMs}\u0000${message.content}`)
    .digest('hex');
}

function normalizeTrustedCurrent(raw, options) {
  if (!raw) return null;
  return normalizeMessage({
    openMessageId: raw.messageId,
    openConversationId: raw.conversationId,
    senderOpenDingTalkId: raw.senderId,
    sender: raw.senderName,
    content: raw.content,
    createTime: raw.createdAt,
  }, options);
}

export function normalizeConversationHistory(root, {
  conversationId = '',
  ownerIds = [],
  ownerNames = [],
  currentMessage = null,
} = {}) {
  const normalizedConversationId = String(conversationId || '').trim();
  if (!normalizedConversationId) throw new Error('DingTalk conversation ID is required');
  const normalizedOwnerIds = new Set(
    (Array.isArray(ownerIds) ? ownerIds : [ownerIds]).map(value => String(value || '').trim()).filter(Boolean),
  );
  const normalizedOwnerNames = new Set(
    (Array.isArray(ownerNames) ? ownerNames : [ownerNames]).map(value => String(value || '').trim()).filter(Boolean),
  );
  const options = {
    conversationId: normalizedConversationId,
    ownerIds: normalizedOwnerIds,
    ownerNames: normalizedOwnerNames,
  };
  const messages = rawMessages(root)
    .map(raw => normalizeMessage(raw, options))
    .filter(Boolean);
  const trustedCurrent = normalizeTrustedCurrent(currentMessage, options);
  if (trustedCurrent) messages.push(trustedCurrent);

  const byId = new Map();
  const byFingerprint = new Map();
  for (const message of messages) {
    const key = fingerprint(message);
    const existing = byFingerprint.get(key);
    if (existing) {
      if (!existing.messageId && message.messageId) {
        Object.assign(existing, message);
        byId.set(message.messageId, existing);
      }
      continue;
    }
    if (message.messageId && byId.has(message.messageId)) continue;
    byFingerprint.set(key, message);
    if (message.messageId) byId.set(message.messageId, message);
  }

  const ordered = [...byFingerprint.values()]
    .sort((left, right) => left.createdAtMs - right.createdAtMs
      || left.messageId.localeCompare(right.messageId))
    .slice(-MAX_HISTORY_MESSAGES);
  const resolvedCurrent = trustedCurrent
    ? ordered.find(item => item.messageId === trustedCurrent.messageId)
      || ordered.find(item => fingerprint(item) === fingerprint(trustedCurrent))
      || trustedCurrent
    : null;
  const latestCounterpartyMessage = [...ordered]
    .reverse()
    .find(item => item.direction === 'counterparty') || resolvedCurrent;
  const styleSamples = ordered
    .filter(item => item.direction === 'owner')
    .reverse()
    .slice(0, MAX_STYLE_SAMPLES);

  return {
    messages: ordered,
    currentMessage: resolvedCurrent,
    latestCounterpartyMessage,
    styleSamples,
  };
}

function displayTime(message) {
  const text = String(message.createdAt || '').trim();
  return text || (message.createdAtMs ? new Date(message.createdAtMs).toISOString() : '时间未知');
}

function speaker(message) {
  if (message.direction === 'owner') return '阿充';
  return message.senderName || '对方';
}

export function formatConversationContext(context = {}) {
  const messages = Array.isArray(context.messages) ? context.messages : [];
  const target = context.latestCounterpartyMessage;
  const styles = Array.isArray(context.styleSamples) ? context.styleSamples : [];
  return [
    `当前钉钉会话最近 30 条真实消息（实际读取 ${messages.length} 条）：`,
    messages.length
      ? messages.map(item => `[${displayTime(item)}] ${speaker(item)}：${item.content}`).join('\n')
      : '（当前会话没有可用历史）',
    '',
    '当前回应目标：',
    target ? `${speaker(target)}：${target.content}` : '（没有可确认的对方消息）',
    '',
    '阿充在本会话中的表达风格样本：',
    styles.length ? styles.map(item => `阿充：${item.content}`).join('\n') : '（无，使用 Persona 默认风格）',
  ].join('\n');
}
