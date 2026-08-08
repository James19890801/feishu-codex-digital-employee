import { semanticTopic } from './semantic-repeat-guard.mjs';

export const SEMANTIC_REPEAT_CLOSE_REPLY = '这个话题我们先到这里，有新情况再 @ 我。';

export function semanticRepeatEligibility({
  enabled,
  channel,
  chatType,
  messageType,
  text,
  operatorCommand = null,
} = {}) {
  if (!enabled) return { eligible: false, reason: 'disabled' };
  if (chatType !== 'group') return { eligible: false, reason: 'direct_message_bypass' };
  if (!['feishu', 'dingtalk'].includes(channel)) {
    return { eligible: false, reason: 'channel_bypass' };
  }
  if (!['text', 'post'].includes(messageType) || !String(text || '').trim()) {
    return { eligible: false, reason: 'non_text_bypass' };
  }
  if (operatorCommand) return { eligible: false, reason: 'operator_command_bypass' };
  return { eligible: true, reason: 'eligible' };
}

export async function applySemanticRepeatGate({
  state,
  enabled,
  windowMs,
  maxReplies,
  channel,
  senderId,
  message,
  text,
  operatorCommand = null,
  nowMs = Date.now(),
  sendClose,
  audit = () => {},
} = {}) {
  const eligibility = semanticRepeatEligibility({
    enabled,
    channel,
    chatType: message?.chat_type,
    messageType: message?.message_type,
    text,
    operatorCommand,
  });
  if (!eligibility.eligible) {
    return { handled: false, action: 'bypass', reason: eligibility.reason };
  }
  const claim = state.claimSemanticRepeat({
    channel,
    chatId: message.chat_id,
    senderId,
    messageId: message.message_id,
    topic: semanticTopic(text),
    nowMs,
    windowMs,
    maxReplies,
  });
  const detail = {
    channel,
    chatId: message.chat_id,
    senderId,
    count: claim.count,
    similarity: claim.similarity,
    reason: claim.reason,
    expiresAt: new Date(claim.expiresAtMs).toISOString(),
  };
  if (claim.action === 'process') {
    audit(claim.reset ? 'semantic_repeat_reset' : 'semantic_repeat_first_seen', detail);
    return { handled: false, ...claim };
  }
  if (claim.action === 'close') {
    await sendClose(
      SEMANTIC_REPEAT_CLOSE_REPLY,
      `aipro-semantic-repeat-close-${message.message_id}`,
    );
    audit('semantic_repeat_closed', detail);
    return { handled: true, ...claim };
  }
  audit('semantic_repeat_suppressed', detail);
  return { handled: true, ...claim };
}
