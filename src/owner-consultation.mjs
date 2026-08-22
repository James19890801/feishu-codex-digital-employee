function bounded(value, limit = 1_000) {
  return String(value || '').replace(/\r\n?/g, '\n').trim().slice(0, limit);
}

const EXPLICIT_REQUEST = /(?:去|帮我|麻烦你|请你)?(?:问(?:一下|下)?|请示|找|跟|向).{0,8}詹老师|请詹老师.{0,8}(?:确认|决定|同意|回复)|(?:转达|告诉).{0,8}詹老师/u;
const NEGATED_REQUEST = /(?:不用|不必|别|无需|不要).{0,10}(?:问|找|请示|转达).{0,8}詹老师/u;
const QUOTED_REQUEST = /[“"「『][^”"」』]{0,80}(?:问|找|请示|转达).{0,8}詹老师[^”"」』]{0,80}[”"」』]/u;
const CONTEXT_ACCEPT = /^(?:好|好的|可以|行|那好)[，,。！! ]*(?:你)?(?:去)?(?:问|找|请示)(?:吧|一下|下)?[。！! ]*$/u;
const ASSISTANT_OFFER = /需要詹老师.{0,12}(?:确认|决定|同意)|(?:要我|我可以).{0,8}(?:问|找).{0,6}詹老师/u;

export function detectOwnerConsultationRequest({ text, recentAssistantText = '' } = {}) {
  const source = bounded(text, 2_000);
  if (!source || NEGATED_REQUEST.test(source) || QUOTED_REQUEST.test(source)) {
    return { triggered: false };
  }
  if (EXPLICIT_REQUEST.test(source)) return { triggered: true };
  if (CONTEXT_ACCEPT.test(source) && ASSISTANT_OFFER.test(bounded(recentAssistantText, 1_000))) {
    return { triggered: true };
  }
  return { triggered: false };
}

export function buildOwnerConsultationMessage({
  requesterLabel = '一位微信联系人',
  requestText = '',
  decisionPrompt = '',
  suggestedReply = '',
} = {}) {
  const requester = bounded(requesterLabel, 100) || '一位微信联系人';
  const request = bounded(requestText, 1_200) || '（没有可用摘要）';
  const decision = bounded(decisionPrompt, 500) || '是否同意对方提出的事项';
  const suggestion = bounded(suggestedReply, 800) || '我收到您的意见后再回复对方。';
  return [
    `詹老师，${requester}请我来问您：`,
    request,
    `需要您确认：${decision}`,
    `建议回复：${suggestion}`,
    '您可以直接引用这条消息回复“同意”“不同意”，或回复“改成：……”。',
  ].join('\n\n');
}

export function parseOwnerConsultationDecision(value) {
  const text = bounded(value, 1_200).replace(/[。！!]+$/u, '').trim();
  if (/^(?:同意|可以|行|好的?|没问题)$/u.test(text)) {
    return { kind: 'approve', approvedReply: '' };
  }
  if (/^(?:不同意|不可以|不行|暂不安排|拒绝)$/u.test(text)) {
    return { kind: 'reject', approvedReply: '' };
  }
  const revised = text.match(/^(?:改成|回复|告诉(?:她|他|对方)|转告(?:她|他|对方))[：:，,]?\s*([\s\S]+)$/u);
  if (revised?.[1]?.trim()) {
    return { kind: 'revise', approvedReply: revised[1].trim().slice(0, 800) };
  }
  return { kind: 'ambiguous', approvedReply: '' };
}

export function buildRequesterRelay({ decision, approvedReply = '' } = {}) {
  if (decision === 'reject') return '我问过詹老师了，他暂时没有同意这件事。';
  const reply = bounded(approvedReply, 800);
  return reply ? `我问过詹老师了，他回复：${reply}` : '';
}
