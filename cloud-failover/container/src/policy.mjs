import { createHash } from 'node:crypto';

const HIGH_RISK = /(?:付款|转账|支付|签署|代签|录用|辞退|密码|验证码|私钥|删除全部|代表我|替我承诺)/;
const MUTATION = /(?:发送给|发给|发布|提交|报名|申请|创建|新建|修改|取消).{0,12}(?:待办|任务|日程|会议|群聊|权限|邮件)?/;

export function validateContainerEnvironment(env = {}) {
  for (const prohibited of ['DWS_PROFILE', 'DWS_CHANNEL', 'LOCAL_DWS_PROFILE', 'LOCAL_DWS_CHANNEL']) {
    if (String(env[prohibited] || '').trim()) throw new Error(`${prohibited} is prohibited in cloud failover`);
  }
  const required = [
    'DINGTALK_CLIENT_ID', 'DINGTALK_CLIENT_SECRET', 'DINGTALK_DWS_AUTH_BUNDLE_B64',
    'AIPROS_COORDINATOR_URL', 'AIPROS_CONTAINER_TOKEN', 'AIPROS_ALLOWED_CHAT_IDS',
  ];
  for (const key of required) if (!String(env[key] || '').trim()) throw new Error(`${key} is required`);
  return {
    allowedChatIds: new Set(String(env.AIPROS_ALLOWED_CHAT_IDS).split(',').map(x => x.trim()).filter(Boolean)),
    allowedSenderIds: new Set(String(env.AIPROS_ALLOWED_SENDER_IDS || '').split(',').map(x => x.trim()).filter(Boolean)),
  };
}

export function stableMessageUuid(channel, messageId) {
  const value = createHash('sha256').update(`${channel}:${messageId}`).digest('hex').slice(0, 32).split('');
  value[12] = '5';
  value[16] = ((parseInt(value[16], 16) & 3) | 8).toString(16);
  return `${value.slice(0, 8).join('')}-${value.slice(8, 12).join('')}-${value.slice(12, 16).join('')}-${value.slice(16, 20).join('')}-${value.slice(20).join('')}`;
}

export function normalizeDwsMessage(input = {}) {
  const messageId = String(input.messageId || input.message_id || input.msgId || input.id || '').trim();
  const chatId = String(input.openConversationId || input.conversationId || input.chatId || input.chat_id || '').trim();
  const senderId = String(input.senderId || input.senderStaffId || input.sender_id || '').trim();
  const text = String(input.text?.content || input.content?.text || input.content || input.text || '').trim();
  const createdAt = Number(input.createTime || input.createdAt || input.timestamp || Date.now());
  const messageType = String(input.messageType || input.msgType || input.type || 'text').toLowerCase();
  return { messageId, chatId, senderId, text, createdAt, messageType, raw: undefined };
}

export function evaluateCloudMessage(message, { allowedChatIds, allowedSenderIds, generation, expectedGeneration, now = Date.now() }) {
  if (Number(generation) !== Number(expectedGeneration)) return { allowed: false, reason: 'stale_generation' };
  if (!message.messageId || !message.chatId || !message.senderId) return { allowed: false, reason: 'invalid_message' };
  if (!allowedChatIds.has(message.chatId)) return { allowed: false, reason: 'unauthorized_chat' };
  if (allowedSenderIds.size && !allowedSenderIds.has(message.senderId)) return { allowed: false, reason: 'unauthorized_sender' };
  if (message.createdAt < now - 3 * 60_000) return { allowed: false, reason: 'outside_backfill_window' };
  if (message.messageType !== 'text') return { allowed: false, reason: 'non_text' };
  if (HIGH_RISK.test(message.text)) return { allowed: true, level: 'L3', handoff: true };
  if (MUTATION.test(message.text)) return { allowed: true, level: 'L2', handoff: true };
  return { allowed: true, level: /(?:方案|报告|总结)/.test(message.text) ? 'L1' : 'L0', handoff: false };
}

export function cloudReply(text) { return `【云端兜底】${String(text || '').trim()}`; }
export function ownerHandoffReply() {
  return cloudReply('这件事需要本人确认，我先不代为操作；已保留请求，等本人在线后处理。');
}
export function messageDigest(messageId) {
  return createHash('sha256').update(String(messageId || '')).digest('hex');
}
