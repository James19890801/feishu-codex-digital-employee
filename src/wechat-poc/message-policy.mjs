import { createHash } from 'node:crypto';

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function rejected(reason) {
  return { accepted: false, reason };
}

function systemLikeText(text) {
  return /(?:撤回了一条消息|你撤回了一条消息|\[红包\]|微信红包|转账\s*[￥¥]?\s*\d|已收款|已退款|以下为新消息|以上是打招呼的内容)/i
    .test(text);
}

export function messageFingerprint(event) {
  return sha256(JSON.stringify([
    event?.sourceMessageId || '',
    event?.conversationKind || '',
    event?.conversationTitle || '',
    event?.senderName || '',
    event?.direction || '',
    event?.text || '',
    event?.messageAt || event?.observedAt || '',
  ]));
}

export function wechatChatId(event) {
  const kind = event?.conversationKind === 'group' ? 'group' : 'user';
  const identity = sha256(`${kind}:${String(event?.conversationTitle || '').trim()}`).slice(0, 32);
  return `wechat-poc:${kind}:${identity}`;
}

export function normalizeObservedMessage(observation) {
  if (!observation || typeof observation !== 'object') return rejected('invalid_observation');
  if (observation.direction !== 'incoming') return rejected('not_incoming');
  if (observation.contentType !== 'text') return rejected('unsupported_content');
  const conversationKind = observation.conversationKind;
  if (!['direct', 'group'].includes(conversationKind)) return rejected('invalid_conversation_kind');
  const conversationTitle = String(observation.conversationTitle || '').trim();
  if (!conversationTitle) return rejected('missing_conversation');
  const text = String(observation.text || '').trim();
  if (!text) return rejected('empty_text');
  if (systemLikeText(text)) return rejected('system_or_transaction');
  if (conversationKind === 'group' && observation.mentionedSelf !== true) {
    return rejected('group_without_mention');
  }
  const senderName = String(observation.senderName || conversationTitle).trim();
  const event = {
    sourceMessageId: String(observation.sourceMessageId || ''),
    conversationKind,
    conversationTitle,
    senderName,
    senderId: `wechat-poc-sender:${sha256(senderName).slice(0, 32)}`,
    direction: 'incoming',
    contentType: 'text',
    text: text.slice(0, 20_000),
    mentionedSelf: conversationKind === 'group',
    observedAt: String(observation.observedAt || new Date().toISOString()),
    messageAt: String(observation.messageAt || observation.observedAt || ''),
  };
  event.chatId = wechatChatId(event);
  event.messageId = messageFingerprint(event);
  return { accepted: true, event };
}
