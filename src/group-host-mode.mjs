import { evaluateDiscussionValue } from './discussion-value.mjs';
import { compareSemanticTopics, semanticTopic } from './semantic-repeat-guard.mjs';

const LOW_INFORMATION_PATTERN = /^(?:大家好|各位好|你好|您好|收到|好的?|可以|行|嗯+|谢谢|感谢|辛苦了|赞|哈哈+)[。！!,.，\s]*$/iu;
const PUBLIC_QUESTION_PATTERN = /[?？]|(?:大家|各位|你们|群里).{0,12}(?:怎么看|怎么想|认为|觉得|有没有|是否|能不能|建议)/u;
const DISCUSSION_CUE_PATTERN = /(?:怎么看|讨论|观点|判断|影响|变化|趋势|方案|建议|案例|新闻|意味着|风险|机会|值得)/u;
const ADMIN_ANNOUNCEMENT_PATTERN = /^(?:通知|提醒|会议|日程|时间|地点|链接|材料).{0,30}(?:改到|调整|定在|安排|发送|已发|请查收)/u;

function normalizedText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function assessGroupHostCandidate({
  enabled = false,
  allowlisted = false,
  chatType = '',
  messageType = 'text',
  text = '',
  mentionedOther = false,
  addressedAssistant = false,
  explicitMention = false,
  continuation = false,
} = {}) {
  const content = normalizedText(text);
  if (!enabled) return { eligible: false, reasonCode: 'disabled' };
  if (!allowlisted) return { eligible: false, reasonCode: 'chat_not_allowlisted' };
  if (chatType !== 'group') return { eligible: false, reasonCode: 'non_group' };
  if (!['text', 'post'].includes(messageType) || !content) {
    return { eligible: false, reasonCode: 'unsupported_or_empty' };
  }
  if (mentionedOther) return { eligible: false, reasonCode: 'addressed_other' };
  if (addressedAssistant || explicitMention || continuation) {
    return { eligible: false, reasonCode: 'immediate_reply_path' };
  }
  if (LOW_INFORMATION_PATTERN.test(content)) {
    return { eligible: false, reasonCode: 'low_information' };
  }
  if (ADMIN_ANNOUNCEMENT_PATTERN.test(content)) {
    return { eligible: false, reasonCode: 'administrative_announcement' };
  }
  const value = evaluateDiscussionValue({ text: content });
  const publicQuestion = PUBLIC_QUESTION_PATTERN.test(content);
  const substantiveTopic = value.substantive
    && [...content].length >= 20
    && DISCUSSION_CUE_PATTERN.test(content);
  if (!publicQuestion && !substantiveTopic) {
    return { eligible: false, reasonCode: 'no_discussion_opening' };
  }
  return {
    eligible: true,
    reasonCode: publicQuestion ? 'public_question' : 'substantive_topic',
    topic: value.topic,
  };
}

export function relatedHumanReply(candidate, laterMessages = []) {
  const candidateTopic = candidate?.topic?.signature
    ? candidate.topic
    : semanticTopic(candidate?.text || '');
  const publicQuestion = PUBLIC_QUESTION_PATTERN.test(String(candidate?.text || ''));
  return (Array.isArray(laterMessages) ? laterMessages : []).some(message => {
    if (message?.role !== 'user') return false;
    if (!message?.senderId || message.senderId === candidate?.senderId) return false;
    const content = normalizedText(message.content);
    if (!content || LOW_INFORMATION_PATTERN.test(content) || ADMIN_ANNOUNCEMENT_PATTERN.test(content)) {
      return false;
    }
    const value = evaluateDiscussionValue({ text: content });
    const comparison = compareSemanticTopics(candidateTopic, value.topic, {
      keywordThreshold: 0.42,
      shingleThreshold: 0.48,
      minFuzzyChars: 6,
    });
    return comparison.repeat || (publicQuestion && [...content].length >= 12);
  });
}

function transcript(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .slice(-30)
    .map(item => `${item?.role === 'assistant' ? '数字人' : `群成员[${String(item?.senderId || '未知')}]`}：${normalizedText(item?.content).slice(0, 1000)}`)
    .join('\n') || '（没有后续消息）';
}

export function buildGroupHostDecisionPrompt({ candidate = {}, laterMessages = [] } = {}) {
  return `
你是群主持介入判定器，只判断一个公共话题经过静默窗口后是否仍然无人接话，不生成回复正文。

判定规则：
1. 若其他群成员已经围绕原话题表达观点、回答、追问或给出证据，输出 human_picked_up。
2. 原发送者自己的补充不算其他成员接话。
3. 后续只有无关闲聊、通知、表情或礼貌确认时，仍可 host。
4. 不确定、上下文不足或话题已经自然结束时必须 observe。
5. 只输出一个 JSON 对象，不要 Markdown，不要解释。

输出格式：
{"action":"host|human_picked_up|observe","confidence":0到1之间的小数,"reasonCode":"简短英文原因"}

原发送者：${String(candidate.senderId || '')}
原话题：${normalizedText(candidate.text).slice(0, 3000)}

静默窗口内的后续消息：
${transcript(laterMessages)}
`.trim();
}

export function parseGroupHostDecision(output, { threshold = 0.84 } = {}) {
  let parsed;
  try { parsed = JSON.parse(String(output || '').trim()); } catch { parsed = null; }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    return { shouldHost: false, confidence: 0, reasonCode: 'invalid_classifier_output' };
  }
  const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
  const reasonCode = String(parsed.reasonCode || 'unspecified')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 64) || 'unspecified';
  return {
    shouldHost: parsed.action === 'host' && confidence >= Number(threshold || 0.84),
    confidence,
    reasonCode,
  };
}

export function buildGroupHostReplyPrompt({ candidate = {}, recentMessages = [] } = {}) {
  return `
你是这个群的克制型主持人。下面的公共话题已经经过静默窗口，仍然没有其他成员接话。

请生成一条 60–180 个中文字符的回复，必须依次完成三件事：
1. 简短承接原话题，不能只说“收到”“好问题”；
2. 补充一个增量观察、关键区别或实际影响；
3. 最后只提出一个开放问题，邀请群成员继续表达。

不得写成长文，不得虚构成员观点，不得声称群内已经形成共识，不得代表任何人承诺，不得执行业务操作，不得包含 Markdown 标题。

原发送者：${String(candidate.senderId || '')}
原话题：${normalizedText(candidate.text).slice(0, 3000)}

最近群聊：
${transcript(recentMessages)}
`.trim();
}

export function normalizeGroupHostReply(output) {
  const content = normalizedText(output)
    .replace(/^```(?:markdown|text)?/iu, '')
    .replace(/```$/u, '')
    .trim();
  const length = [...content].length;
  const questions = content.match(/[?？]/gu) || [];
  if (length < 60 || length > 180 || questions.length !== 1 || !/[?？]$/u.test(content)) return '';
  return content;
}

function messagesAfterCandidate(candidate, recentMessages = []) {
  const messages = Array.isArray(recentMessages) ? recentMessages : [];
  const sourceIndex = messages.findIndex(message => (
    candidate?.messageId
    && message?.sourceMessageId === candidate.messageId
  ));
  if (sourceIndex >= 0) return messages.slice(sourceIndex + 1);
  const createdAtMs = Number(candidate?.createdAtMs || 0);
  if (!createdAtMs) return messages;
  return messages.filter(message => {
    const messageCreatedAtMs = Date.parse(String(message?.createdAt || ''));
    return Number.isFinite(messageCreatedAtMs) && messageCreatedAtMs > createdAtMs;
  });
}

function decisionAction(output) {
  try {
    const parsed = JSON.parse(String(output || '').trim());
    return !Array.isArray(parsed) && parsed && typeof parsed === 'object'
      ? String(parsed.action || '')
      : '';
  } catch {
    return '';
  }
}

export async function processGroupHostCandidate({
  candidate = {},
  recentMessages = [],
  takeoverActive = false,
  cooldownActive = false,
  runDecisionClassifier,
  runReplyGenerator,
  send,
} = {}) {
  if (takeoverActive) return { action: 'suppressed', reasonCode: 'human_takeover' };
  if (cooldownActive) return { action: 'suppressed', reasonCode: 'reply_cooldown' };

  const laterMessages = messagesAfterCandidate(candidate, recentMessages);
  if (relatedHumanReply(candidate, laterMessages)) {
    return { action: 'human_picked_up', reasonCode: 'related_human_reply' };
  }
  if (typeof runDecisionClassifier !== 'function') {
    return { action: 'observe', reasonCode: 'classifier_unavailable' };
  }

  let classifierOutput = '';
  try {
    classifierOutput = await runDecisionClassifier(buildGroupHostDecisionPrompt({
      candidate,
      laterMessages,
    }));
  } catch {
    return { action: 'observe', reasonCode: 'classifier_error' };
  }
  const decision = parseGroupHostDecision(classifierOutput);
  if (!decision.shouldHost) {
    return {
      action: decisionAction(classifierOutput) === 'human_picked_up'
        ? 'human_picked_up'
        : 'observe',
      reasonCode: decision.reasonCode,
    };
  }
  if (typeof runReplyGenerator !== 'function' || typeof send !== 'function') {
    return { action: 'observe', reasonCode: 'reply_path_unavailable' };
  }

  const generated = await runReplyGenerator(buildGroupHostReplyPrompt({
    candidate,
    recentMessages,
  }));
  const reply = normalizeGroupHostReply(generated);
  if (!reply) return { action: 'observe', reasonCode: 'invalid_reply' };
  const sendResult = await send(reply);
  if (sendResult?.suppressed) return { action: 'observe', reasonCode: 'send_suppressed' };
  return { action: 'replied', reasonCode: decision.reasonCode, reply };
}
