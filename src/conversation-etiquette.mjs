const DETAILED_REQUEST = /(?:方案|报告|分析|文档|总结|计划|步骤|清单|教程|复盘|对比|长文|完整|详细|深入|系统性|全面)/;
const TERSE_SOCIAL_REQUEST = /^(?:你好|您好|嗨|hi|hello|在吗|嗯|哦|好|好的|收到|谢谢|感谢|辛苦了|可以吗|行吗)[呀啊吗呢哦。！!？? ]*$/i;

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
