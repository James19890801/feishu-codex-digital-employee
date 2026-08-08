const LOW_INFORMATION_PATTERN = /^(?:好(?:的|呀|啊|哦)?|嗯+|收到|知道了|可以|行|没问题|谢谢|感谢|赞|哈哈+|呵呵+|ok|okay)[。！!,.，\s]*$/iu;
const QUESTION_OR_REQUEST_PATTERN = /[?？]|(?:怎么|如何|为什么|为何|能不能|是否|请问|谁能|有没有|应该|需要|可以|帮忙|帮我|看一下|分析|解释|给个建议)/u;
const DEFAULT_CONTINUATION_WINDOW_MS = 10 * 60_000;

function normalizedText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function result(action, reasonCode, extra = {}) {
  return { action, reasonCode, ...extra };
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
  if (explicitMention) return result('reply_explicit', 'explicit_mention');

  const named = (Array.isArray(aliases) ? aliases : [])
    .map(normalizedText)
    .filter(Boolean)
    .some(alias => content.toLocaleLowerCase().includes(alias.toLocaleLowerCase()));
  if (named) return result('reply_named', 'assistant_alias');
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
