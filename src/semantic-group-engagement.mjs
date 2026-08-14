const LOW_INFORMATION_PATTERN = /^(?:好(?:的|呀|啊|哦)?|嗯+|收到|知道了|可以|行|没问题|谢谢|感谢|赞|哈哈+|呵呵+|ok|okay)[。！!,.，\s]*$/iu;
const TERMINAL_ACKNOWLEDGEMENT_PATTERN = /^(?:好(?:的|呀|啊|哦)?|嗯+|收到|知道了|明白|可以|行|没问题)[，,。！!\s]+.*(?:等你|等.{0,10}(?:恢复|消息|回复|发来)|不重复(?:发|说)?|先这样|就这样|发来我)/iu;
const QUESTION_OR_REQUEST_PATTERN = /[?？]|(?:怎么|如何|为什么|为何|能不能|是否|请问|谁能|有没有|应该|需要|可以|帮忙|帮我|看一下|分析|解释|给个建议)/u;
const DEFAULT_CONTINUATION_WINDOW_MS = 10 * 60_000;

function normalizedText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function directlyAddressesAlias(content, alias) {
  const source = content.toLocaleLowerCase();
  const target = alias.toLocaleLowerCase();
  const index = source.indexOf(target);
  if (index < 0) return false;
  const before = source.slice(0, index).trim();
  const after = source.slice(index + target.length).trimStart();
  const directPrefix = !before || /^(?:请问|想问(?:下|一下)?|麻烦)$/u.test(before)
    || /[，,。！？!?：:]$/u.test(before);
  const directSuffix = !after || /^[，,。！？!?：:]/u.test(after)
    || /^(?:你|请|帮|在吗|能否|能不能|可以|回答|看看|看下|怎么|如何|为什么|是否|需要)/u.test(after);
  return directPrefix && directSuffix;
}

function escapedPattern(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function explicitlyMentionsAlias(content, alias) {
  const target = escapedPattern(alias);
  if (!target) return false;
  return new RegExp(`[@＠]\\s*${target}(?=$|[\\s，,。！？!?：:])`, 'iu').test(content);
}

function withoutAssistantAddressing(content, aliases) {
  let value = content;
  for (const alias of aliases) {
    const target = escapedPattern(alias);
    value = value
      .replace(new RegExp(`[@＠]\\s*${target}(?=$|[\\s，,。！？!?：:])`, 'giu'), ' ')
      .replace(new RegExp(`^\\s*${target}(?=$|[\\s，,。！？!?：:])`, 'iu'), ' ');
  }
  return normalizedText(value.replace(/^[，,。！？!?：:\s]+|[，,。！？!?：:\s]+$/gu, ''));
}

function isNonSubstantiveAddress(content, aliases = []) {
  const addressedContent = withoutAssistantAddressing(content, aliases);
  if (!addressedContent || QUESTION_OR_REQUEST_PATTERN.test(addressedContent)) return false;
  return LOW_INFORMATION_PATTERN.test(addressedContent)
    || TERMINAL_ACKNOWLEDGEMENT_PATTERN.test(addressedContent);
}

function result(action, reasonCode, extra = {}) {
  return { action, reasonCode, ...extra };
}

export function isSemanticEntryCooldownActive({
  lastReplyAtMs = 0,
  nowMs = Date.now(),
  cooldownMs = 120_000,
  activeDiscussion = false,
} = {}) {
  if (activeDiscussion) return false;
  const elapsed = Number(nowMs) - Number(lastReplyAtMs || 0);
  return Number(lastReplyAtMs) > 0 && elapsed >= 0 && elapsed < Number(cooldownMs || 0);
}

function recentlyAddressedSender(recentMessages, senderId, nowMs, windowMs) {
  const recent = (Array.isArray(recentMessages) ? recentMessages : [])
    .slice(-30)
    .reverse()
    .find(item => item?.role === 'assistant' && String(item?.senderId || '') === senderId);
  if (!recent) return false;
  const createdAtMs = Date.parse(String(recent.createdAt || ''));
  return Number.isFinite(createdAtMs) && nowMs - createdAtMs >= 0 && nowMs - createdAtMs <= windowMs;
}

export function assessGroupEngagement({
  enabled,
  chatType,
  messageType = 'text',
  text,
  explicitMention = false,
  aliases = [],
  recentMessages = [],
  currentSenderId = '',
  humanTakeover = false,
  mentionedOther = false,
  cooldownActive = false,
  activeDiscussion = false,
  nowMs = Date.now(),
  continuationWindowMs = DEFAULT_CONTINUATION_WINDOW_MS,
} = {}) {
  const content = normalizedText(text);
  if (!enabled) return result('observe', 'disabled');
  if (chatType !== 'group') return result('observe', 'non_group');
  if (!['text', 'post'].includes(messageType) || !content) {
    return result('observe', 'unsupported_or_empty');
  }
  if (humanTakeover) return result('suppress', 'human_takeover');
  const normalizedAliases = (Array.isArray(aliases) ? aliases : [])
    .map(normalizedText)
    .filter(Boolean);
  if (explicitMention) {
    return result('reply_explicit', 'explicit_mention', { responseRequired: true });
  }
  if (isNonSubstantiveAddress(content, normalizedAliases)) {
    return result('observe', 'low_information');
  }

  const explicitAlias = normalizedAliases
    .some(alias => explicitlyMentionsAlias(content, alias));
  const named = explicitAlias || normalizedAliases
    .some(alias => directlyAddressesAlias(content, alias));
  if (named) {
    return result('reply_named', 'assistant_alias', { responseRequired: explicitAlias });
  }
  if (mentionedOther) return result('observe', 'addressed_other');
  if (LOW_INFORMATION_PATTERN.test(content)) return result('observe', 'low_information');

  if (recentlyAddressedSender(
    recentMessages,
    String(currentSenderId || ''),
    Number(nowMs),
    Number(continuationWindowMs),
  ) && QUESTION_OR_REQUEST_PATTERN.test(content)) {
    return result('reply_continuation', 'recent_assistant_exchange');
  }
  if (cooldownActive && !activeDiscussion) return result('suppress', 'entry_cooldown');
  if (QUESTION_OR_REQUEST_PATTERN.test(content)) return result('classify', 'plausible_request');
  if (activeDiscussion && content.length >= 12) return result('classify', 'active_discussion');
  return result('observe', 'ambient_chatter');
}

export function buildSemanticEngagementPrompt({
  text,
  senderId = '',
  recentMessages = [],
} = {}) {
  const transcript = (Array.isArray(recentMessages) ? recentMessages : [])
    .slice(-30)
    .map(item => `${item?.role === 'assistant' ? '数字人' : `群成员[${String(item?.senderId || '未知')}]`}：${normalizedText(item?.content).slice(0, 1800)}`)
    .join('\n') || '（没有更早的可用上下文）';
  return `
你是群聊介入判定器，只判断数字人现在是否应该回复，不生成回复正文。

判定标准：
1. 只有当前消息明显在向数字人、詹老师助理提问，承接数字人刚才的话，或要求数字人参与当前任务时才 reply。
2. 群成员之间的闲聊、对他人的提问、礼貌确认、没有明确增量的内容必须 observe。
3. 不得因为数字人“能够回答”就自动认为“应该插话”。不确定时必须 observe。
4. 只输出一个 JSON 对象，不要 Markdown，不要解释。

输出格式：
{"action":"reply|observe","confidence":0到1之间的小数,"reasonCode":"简短英文原因","targetSenderIds":["当前发送者ID"]}

最近30条群聊：
${transcript}

当前发送者ID：${String(senderId || '')}
当前消息：${normalizedText(text).slice(0, 4000)}
`.trim();
}

function observe(reasonCode = 'invalid_classifier_output', confidence = 0) {
  return { action: 'observe', confidence, reasonCode, targetSenderIds: [] };
}

export function parseSemanticEngagementDecision(output, {
  threshold = 0.86,
  defaultSenderId = '',
  allowedSenderIds = [],
} = {}) {
  let parsed;
  try {
    parsed = JSON.parse(String(output || '').trim());
  } catch {
    return observe();
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return observe();
  const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
  const reasonCode = String(parsed.reasonCode || 'unspecified')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 64) || 'unspecified';
  if (parsed.action !== 'reply' || confidence < Number(threshold || 0.86)) {
    return observe(reasonCode, confidence);
  }
  const fallbackId = String(defaultSenderId || '').trim();
  const allowed = new Set([
    ...allowedSenderIds,
    fallbackId,
  ].map(value => String(value || '').trim()).filter(Boolean));
  const targetSenderIds = [...new Set((Array.isArray(parsed.targetSenderIds)
    ? parsed.targetSenderIds : [])
    .map(value => String(value || '').trim())
    .filter(value => allowed.has(value)))].slice(0, 20);
  if (!targetSenderIds.length && fallbackId) targetSenderIds.push(fallbackId);
  return { action: 'reply_semantic', confidence, reasonCode, targetSenderIds };
}

export async function decideSemanticGroupEngagement({
  assessment = {},
  recentMessages = [],
  threshold = 0.86,
  runClassifier,
  deferHost = false,
} = {}) {
  const effectiveRecentMessages = Array.isArray(assessment.recentMessages)
    && assessment.recentMessages.length
    ? assessment.recentMessages
    : recentMessages;
  const local = assessGroupEngagement({
    ...assessment,
    recentMessages: effectiveRecentMessages,
  });
  if (['reply_explicit', 'reply_named', 'reply_continuation'].includes(local.action)) {
    const senderId = String(assessment.currentSenderId || '').trim();
    return {
      shouldReply: true,
      action: local.action,
      reasonCode: local.reasonCode,
      confidence: 1,
      targetSenderIds: senderId ? [senderId] : [],
      responseRequired: local.responseRequired === true,
    };
  }
  const hostDeferrable = local.action === 'classify'
    || ['ambient_chatter', 'entry_cooldown'].includes(local.reasonCode);
  if (deferHost && hostDeferrable) {
    return {
      shouldReply: false,
      action: 'defer_host',
      reasonCode: 'group_host_silence_window',
      confidence: 1,
      targetSenderIds: [],
    };
  }
  if (local.action !== 'classify') {
    return {
      shouldReply: false,
      action: local.action,
      reasonCode: local.reasonCode,
      confidence: 0,
      targetSenderIds: [],
    };
  }
  if (typeof runClassifier !== 'function') {
    return {
      shouldReply: false,
      action: 'observe',
      reasonCode: 'classifier_unavailable',
      confidence: 0,
      targetSenderIds: [],
    };
  }
  try {
    const output = await runClassifier(buildSemanticEngagementPrompt({
      text: assessment.text,
      senderId: assessment.currentSenderId,
      recentMessages: effectiveRecentMessages,
    }));
    const parsed = parseSemanticEngagementDecision(output, {
      threshold,
      defaultSenderId: assessment.currentSenderId,
    });
    return { shouldReply: parsed.action === 'reply_semantic', ...parsed };
  } catch {
    return {
      shouldReply: false,
      action: 'observe',
      reasonCode: 'classifier_error',
      confidence: 0,
      targetSenderIds: [],
    };
  }
}
