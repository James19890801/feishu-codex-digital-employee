const ACTIONABLE_MESSAGE = /[?？]|(?:请|帮|麻烦|能否|能不能|怎么|如何|为什么|告诉我|给我|查询|查一下|看一下|解释|分析|整理|总结|写|做|创建|新建|修改|取消|提交|发送|继续|展开)/u;
const DEFERRED_FOLLOW_UP = /^(?:我)?(?:先)?(?:整理|看看|确认|处理|想想).{0,16}(?:稍后|晚点|回头|一会儿|等会儿).{0,12}(?:发|回复|联系|找|告诉)(?:你|您)?[。.!！\s]*$/u;
const SOCIAL_CLOSING = /^(?:好|好的|好嘞|行|可以|收到|明白|了解|知道了|谢谢|感谢|辛苦了)(?:[，,\s]*(?:那)?(?:先这样|回头(?:再)?(?:说|联系)|有需要(?:再|随时)?(?:说|联系)|随时(?:说|找我|联系)))?[。.!！\s]*$/u;
const GENERIC_CLOSING_REPLY = /^(?:好|好的|好嘞|行|可以|收到|明白)(?:[，,\s]*(?:有需要|需要的话)?(?:随时)?(?:说|找我|联系我|告诉我|发给我|发过来))?[。.!！\s]*$/u;
const STOP_LOOP_CLOSING = /(?:别|不|停止|收住|收了).{0,6}(?:循环|自动回复)|(?:你|您)(?:也)?(?:先)?去忙/u;
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Component}\u200d\ufe0f\s]+$/u;

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

export function governGeneratedReply(text) {
  const reply = String(text || '').trim();
  return GENERIC_CLOSING_REPLY.test(reply) || STOP_LOOP_CLOSING.test(reply) || EMOJI_ONLY.test(reply)
    ? ''
    : reply;
}
