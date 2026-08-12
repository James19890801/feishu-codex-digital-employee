import { createHash } from 'node:crypto';

const HIGH_RISK = /(?:付款|转账|支付|签署|代签|录用|辞退|密码|验证码|私钥|删除全部|代表我|替我承诺)/;
const MUTATION = /(?:发送给|发给|发布|提交|报名|申请|创建|新建|修改|取消).{0,12}(?:待办|任务|日程|会议|群聊|权限|邮件)?/;
const DINGTALK_IMAGE_PLACEHOLDER = /^\[?图片消息\]?.*?mediaId\s*(?:=|:)\s*([^\s)]+)/i;

export function validateContainerEnvironment(env = {}) {
  for (const prohibited of ['DWS_PROFILE', 'DWS_CHANNEL', 'LOCAL_DWS_PROFILE', 'LOCAL_DWS_CHANNEL']) {
    if (String(env[prohibited] || '').trim()) throw new Error(`${prohibited} is prohibited in cloud failover`);
  }
  const clientId = String(env.DINGTALK_CLIENT_ID || '').trim();
  const clientSecret = String(env.DINGTALK_CLIENT_SECRET || '').trim();
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error('DINGTALK_CLIENT_ID and DINGTALK_CLIENT_SECRET must be provided together');
  }
  const required = [
    'DINGTALK_DWS_AUTH_BUNDLE_B64',
    'AIPROS_CLOUD_DWS_CHANNEL', 'AIPROS_COORDINATOR_URL', 'AIPROS_CONTAINER_TOKEN',
  ];
  for (const key of required) if (!String(env[key] || '').trim()) throw new Error(`${key} is required`);
  if (String(env.AIPROS_ACCESS_MODE || '').trim().toLowerCase() !== 'blacklist') {
    throw new Error('AIPROS_ACCESS_MODE must be blacklist');
  }
  return {
    accessMode: 'blacklist',
    blockedChatIds: new Set(String(env.AIPROS_BLOCKED_CHAT_IDS || '').split(',').map(x => x.trim()).filter(Boolean)),
    blockedSenderIds: new Set(String(env.AIPROS_BLOCKED_SENDER_IDS || '').split(',').map(x => x.trim()).filter(Boolean)),
  };
}

export function stableMessageUuid(channel, messageId) {
  const value = createHash('sha256').update(`${channel}:${messageId}`).digest('hex').slice(0, 32).split('');
  value[12] = '5';
  value[16] = ((parseInt(value[16], 16) & 3) | 8).toString(16);
  return `${value.slice(0, 8).join('')}-${value.slice(8, 12).join('')}-${value.slice(12, 16).join('')}-${value.slice(16, 20).join('')}-${value.slice(20).join('')}`;
}

export function normalizeDwsMessage(input = {}) {
  const eventType = String(input.type || '');
  const messageId = String(input.messageId || input.openMessageId || input.message_id || input.msgId || input.id || '').trim();
  const chatId = String(input.openConversationId || input.conversationId || input.conversation_id || input.chatId || input.chat_id || '').trim();
  const senderId = String(input.senderId || input.senderOpenDingTalkId || input.sender_open_dingtalk_id || input.senderStaffId || input.sender_id || '').trim();
  const text = String(input.text?.content || input.content?.text || input.content || input.text || '').trim();
  const imageMatch = text.match(DINGTALK_IMAGE_PLACEHOLDER);
  const media = imageMatch ? {
    kind: 'image', resourceId: imageMatch[1].trim(), messageId, conversationId: chatId,
  } : undefined;
  const rawCreatedAt = input.createTime || input.create_time || input.createdAt || input.timestamp || Date.now();
  const numericCreatedAt = Number(rawCreatedAt);
  const parsedCreatedAt = Number.isFinite(numericCreatedAt)
    ? (numericCreatedAt < 10_000_000_000 ? numericCreatedAt * 1_000 : numericCreatedAt)
    : new Date(rawCreatedAt).getTime();
  const createdAt = Number.isFinite(parsedCreatedAt) ? parsedCreatedAt : Date.now();
  const messageType = media?.kind || String(
    input.messageType || input.message_type || input.msgType
      || (eventType.startsWith('user_im_message_receive_') ? 'text' : eventType || 'text'),
  ).toLowerCase();
  return { messageId, chatId, senderId, text, createdAt, messageType, ...(media ? { media } : {}), raw: undefined };
}

export function evaluateCloudMessage(message, {
  blockedChatIds, blockedSenderIds, generation, expectedGeneration, now = Date.now(),
}) {
  if (Number(generation) !== Number(expectedGeneration)) return { allowed: false, reason: 'stale_generation' };
  if (!message.messageId || !message.chatId || !message.senderId) return { allowed: false, reason: 'invalid_message' };
  if (blockedChatIds?.has(message.chatId)) return { allowed: false, reason: 'blocked_chat' };
  if (blockedSenderIds?.has(message.senderId)) return { allowed: false, reason: 'blocked_sender' };
  if (message.createdAt < now - 3 * 60_000) return { allowed: false, reason: 'outside_backfill_window' };
  if (!['text', 'image'].includes(message.messageType)) return { allowed: false, reason: 'non_text' };
  if (HIGH_RISK.test(message.text)) return { allowed: true, level: 'L3', handoff: true };
  if (MUTATION.test(message.text)) return { allowed: true, level: 'L2', handoff: true };
  return { allowed: true, level: /(?:方案|报告|总结)/.test(message.text) ? 'L1' : 'L0', handoff: false };
}

export function cloudReply(text) { return String(text || '').trim(); }
export function ownerHandoffReply() {
  return cloudReply('这件事需要本人确认，我先不代为操作；已保留请求，等本人在线后处理。');
}
export function messageDigest(messageId) {
  return createHash('sha256').update(String(messageId || '')).digest('hex');
}
