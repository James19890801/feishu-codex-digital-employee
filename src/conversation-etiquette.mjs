const DETAILED_REQUEST = /(?:方案|报告|分析|文档|总结|计划|步骤|清单|教程|复盘|对比|长文|完整|详细|深入|系统性|全面|核心看点|创新(?:的)?点|主要亮点|核心价值)/;
const TERSE_SOCIAL_REQUEST = /^(?:你好|您好|嗨|hi|hello|在吗|嗯|哦|好|好的|收到|谢谢|感谢|辛苦了|可以吗|行吗)[呀啊吗呢哦。！!？? ]*$/i;

export function replyLengthPolicy(request) {
  const text = String(request || '').trim();
  if (DETAILED_REQUEST.test(text)) return { detailed: true, maxChars: 3800 };
  if (TERSE_SOCIAL_REQUEST.test(text)) return { detailed: false, maxChars: 48 };
  return { detailed: false, maxChars: 90 };
}

export function enforceReplyLength(answer, _request) {
  return String(answer || '').trim().replace(/\n{3,}/g, '\n\n');
}

export function buildFirstTakeoverGreeting({ channel = '' } = {}) {
  if (String(channel).trim().toLowerCase() === 'wechat') {
    return '你好，我是詹老师的助理。詹老师现在不在，我可以先协助处理公开或已授权的事项；需要他本人决定的内容，我会请他确认。要继续聊吗？';
  }
  return '你好，我是阿充的数字人。阿充现在不在，我可以先协助处理公开或已授权的事项；需要他本人决定的内容，我会请他确认。要继续聊吗？';
}

export function shouldIntroduceAssistant({ chatType, isOwner, history }) {
  if (chatType !== 'p2p' || isOwner) return false;
  return !(Array.isArray(history) ? history : []).some(item => item?.role === 'assistant');
}
