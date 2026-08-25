const DETAILED_REQUEST = /(?:方案|报告|分析|文档|总结|计划|步骤|清单|教程|复盘|对比|推荐|借鉴|长文|完整|详细|深入|系统性|全面)/;
const TERSE_SOCIAL_REQUEST = /^(?:你好|您好|嗨|hi|hello|在吗|嗯|哦|好|好的|收到|谢谢|感谢|辛苦了|可以吗|行吗)[呀啊吗呢哦。！!？? ]*$/i;
const ACTIONABLE_MESSAGE = /[?？]|(?:请|帮|麻烦|能否|能不能|怎么|如何|为什么|告诉我|给我|查询|查一下|看一下|解释|分析|整理|总结|写|做|创建|新建|修改|取消|提交|发送|继续|展开)/u;
const DEFERRED_FOLLOW_UP = /^(?:我)?(?:先)?(?:整理|看看|确认|处理|想想).{0,16}(?:稍后|晚点|回头|一会儿|等会儿).{0,12}(?:发|回复|联系|找|告诉)(?:你|您)?[。.!！\s]*$/u;
const SOCIAL_CLOSING = /^(?:好|好的|好嘞|行|可以|收到|明白|了解|知道了|谢谢|感谢|辛苦了)(?:[，,\s]*(?:那)?(?:先这样|回头(?:再)?(?:说|联系)|有需要(?:再|随时)?(?:说|联系)|随时(?:说|找我|联系)))?[。.!！\s]*$/u;
const GENERIC_CLOSING_REPLY = /^(?:好|好的|好嘞|行|可以|收到|明白)(?:[，,\s]*(?:有需要|需要的话)?(?:随时)?(?:说|找我|联系我|告诉我|发给我|发过来))?[。.!！\s]*$/u;
const STOP_LOOP_CLOSING = /(?:别|不|停止|收住|收了).{0,6}(?:循环|自动回复)|(?:你|您)(?:也)?(?:先)?去忙/u;
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Component}\u200d\ufe0f\s]+$/u;
const OWNER_FACING_DRAFT = /(?:草拟回复|需你确认后发送|你看(?:这样)?(?:回|回复).{0,12}(?:行不行|可以吗)|或者改一下)/u;

export function conversationReplyDisposition(text, { responseRequired = false } = {}) {
  const value = String(text || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (responseRequired || !value) return { reply: true, reason: responseRequired ? 'response_required' : 'actionable' };
  if (DEFERRED_FOLLOW_UP.test(value) || SOCIAL_CLOSING.test(value)
    || STOP_LOOP_CLOSING.test(value) || EMOJI_ONLY.test(value)) {
    return { reply: false, reason: 'conversation_closed' };
  }
  if (ACTIONABLE_MESSAGE.test(value)) return { reply: true, reason: 'actionable' };
  return { reply: true, reason: 'conversation_open' };
}

export function generatedReplyDisposition(text, {
  externalAudience = false,
  responseRequired = false,
} = {}) {
  const reply = String(text || '').trim();
  if (externalAudience && OWNER_FACING_DRAFT.test(reply)) {
    return responseRequired
      ? { text: '收到。', reason: 'owner_facing_draft_fallback' }
      : { text: '', reason: 'owner_facing_draft' };
  }
  if (GENERIC_CLOSING_REPLY.test(reply) || STOP_LOOP_CLOSING.test(reply) || EMOJI_ONLY.test(reply)) {
    return { text: '', reason: 'generic_closing_reply' };
  }
  return { text: reply, reason: 'allowed' };
}

export function governGeneratedReply(text, options = {}) {
  return generatedReplyDisposition(text, options).text;
}

export function replyLengthPolicy(request) {
  const text = String(request || '').trim();
  if (DETAILED_REQUEST.test(text)) return { detailed: true, maxChars: 3800 };
  if (TERSE_SOCIAL_REQUEST.test(text)) return { detailed: false, maxChars: 48 };
  return { detailed: false, maxChars: 90 };
}

function truncateCharacters(text, maxChars) {
  const characters = Array.from(String(text || '').trim());
  if (characters.length <= maxChars) return characters.join('');
  return `${characters.slice(0, Math.max(1, maxChars - 1)).join('').trimEnd()}…`;
}

export function enforceReplyLength(answer, request) {
  const policy = replyLengthPolicy(request);
  const normalized = String(answer || '').trim().replace(/\n{3,}/g, '\n\n');
  return policy.detailed ? truncateCharacters(normalized, policy.maxChars) : truncateCharacters(normalized, policy.maxChars);
}

export function buildFirstTakeoverGreeting({ ownerLabel = '账号本人' } = {}) {
  return `你好，我是${ownerLabel}的数字人。${ownerLabel}现在不在，我可以先协助处理公开或已授权的事项；需要本人决定的内容，我会请他确认。要继续聊吗？`;
}

export function shouldIntroduceAssistant({ chatType, isOwner, history }) {
  if (chatType !== 'p2p' || isOwner) return false;
  return !(Array.isArray(history) ? history : []).some(item => item?.role === 'assistant');
}
