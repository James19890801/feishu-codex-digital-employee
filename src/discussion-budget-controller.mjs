import { evaluateDiscussionValue } from './discussion-value.mjs';

export const DISCUSSION_LOW_VALUE_CLOSE_REPLY = '这轮讨论的信息增量已经很低，我先在这里收束；有新事实、新证据或新问题时再继续。';
export const DISCUSSION_REQUIRED_ACK_REPLY = '收到，这条我看到了；当前讨论刚收束，有新内容我继续接。';

const OWNER_CONTINUE_PATTERN = /^(?:继续讨论|继续辩论|恢复讨论|重新开始讨论)$/u;

export function shouldUseSemanticRepeatFallback({
  semanticEnabled,
  adaptiveEligible,
} = {}) {
  return Boolean(semanticEnabled && !adaptiveEligible);
}

export function appendDiscussionInstruction(task, instruction = '') {
  const normalizedTask = String(task || '').trim();
  const normalizedInstruction = String(instruction || '').trim();
  if (!normalizedInstruction) return normalizedTask;
  return `${normalizedTask}\n\n讨论轮次控制指令（必须执行）：\n${normalizedInstruction}`.trim();
}

export function discussionBudgetEligibility({
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

function normalizedOwnerCommand(text) {
  return String(text || '')
    .replace(/<at\b[^>]*>.*?<\/at>/giu, ' ')
    .replace(/<@[^>]+>/gu, ' ')
    .replace(/[\p{P}\p{S}\s]+/gu, '');
}

function checkpointInstruction(replyCount) {
  if (replyCount === 100) {
    return [
      '这是本轮讨论的第 100 次也是最后一次 AIPRO 回复。',
      '请基于当前对话上下文做最终综合：概括已达成的共识、仍有分歧的判断、关键证据与下一步建议。',
      '明确说明本轮讨论已到上限并结束，不要再提出会诱发无休止确认的新问题。',
    ].join('\n');
  }
  return [
    `这是本轮讨论的第 ${replyCount} 次 AIPRO 回复，请做一次简短阶段总结。`,
    '说明当前共识、主要分歧、已有证据，以及唯一最值得继续讨论的未决问题。',
    '总结后继续回答当前消息，不要机械复述此前内容。',
  ].join('\n');
}

export async function applyDiscussionBudgetGate({
  state,
  enabled,
  maxReplies = 100,
  lowValueLimit = 3,
  cooldownMs = 30 * 60_000,
  sessionWindowMs = 30 * 60_000,
  channel,
  ownerAuthorized = false,
  responseRequired = false,
  message,
  text,
  operatorCommand = null,
  nowMs = Date.now(),
  sendClose,
  audit = () => {},
} = {}) {
  const eligibility = discussionBudgetEligibility({
    enabled,
    channel,
    chatType: message?.chat_type,
    messageType: message?.message_type,
    text,
    operatorCommand,
  });
  if (!eligibility.eligible) {
    return {
      handled: false,
      eligible: false,
      action: 'bypass',
      reason: eligibility.reason,
      checkpointPrompt: '',
      finalizeAfterReply: false,
    };
  }

  const chatId = String(message.chat_id || '');
  const ownerContinue = Boolean(ownerAuthorized
    && OWNER_CONTINUE_PATTERN.test(normalizedOwnerCommand(text)));
  const session = state.discussionSession(channel, chatId);
  const value = evaluateDiscussionValue({
    text,
    recentTopics: session?.recentTopics || [],
  });
  if (!session && !value.substantive && !ownerContinue) {
    return {
      handled: false,
      eligible: false,
      action: 'bypass',
      reason: 'no_active_discussion',
      checkpointPrompt: '',
      finalizeAfterReply: false,
    };
  }

  const claim = state.claimDiscussionTurn({
    channel,
    chatId,
    messageId: message.message_id,
    value,
    ownerContinue,
    nowMs,
    maxReplies,
    lowValueLimit,
    cooldownMs,
    sessionWindowMs,
  });
  const detail = {
    channel,
    chatId,
    sessionNo: claim.sessionNo,
    replyCount: claim.replyCount,
    lowValueStreak: claim.lowValueStreak,
    score: value.score,
    action: claim.action,
    reason: claim.reason,
  };
  if (claim.action === 'suppress_cooldown' || claim.action === 'suppress_finalizing') {
    if (responseRequired) {
      await sendClose(
        DISCUSSION_REQUIRED_ACK_REPLY,
        `aipro-discussion-required-ack-${message.message_id}`,
      );
      audit('discussion_required_acknowledged', detail);
      return {
        handled: true,
        eligible: true,
        ...claim,
        action: 'acknowledge_required',
        suppressedAction: claim.action,
        ownerContinue,
        checkpointPrompt: '',
        finalizeAfterReply: false,
      };
    }
    audit('discussion_suppressed', detail);
    return {
      handled: true,
      eligible: true,
      ...claim,
      ownerContinue,
      checkpointPrompt: '',
      finalizeAfterReply: false,
    };
  }
  if (claim.action === 'close_low_value') {
    await sendClose(
      DISCUSSION_LOW_VALUE_CLOSE_REPLY,
      `aipro-discussion-close-${message.message_id}`,
    );
    audit('discussion_low_value_closed', detail);
    return {
      handled: true,
      eligible: true,
      ...claim,
      ownerContinue,
      checkpointPrompt: '',
      finalizeAfterReply: false,
    };
  }
  if (claim.action === 'checkpoint') {
    audit('discussion_checkpoint', detail);
    return {
      handled: false,
      eligible: true,
      ...claim,
      ownerContinue,
      checkpointPrompt: checkpointInstruction(claim.replyCount),
      finalizeAfterReply: false,
    };
  }
  if (claim.action === 'final') {
    audit('discussion_final_started', detail);
    return {
      handled: false,
      eligible: true,
      ...claim,
      ownerContinue,
      checkpointPrompt: checkpointInstruction(100),
      finalizeAfterReply: true,
    };
  }
  audit(ownerContinue ? 'discussion_owner_restarted' : 'discussion_turn_accepted', detail);
  return {
    handled: false,
    eligible: true,
    ...claim,
    ownerContinue,
    checkpointPrompt: '',
    finalizeAfterReply: false,
  };
}
