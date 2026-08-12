import { assessResponseObligation } from './response-obligation.mjs';
import { resolveRequiredResponse } from './required-response-fallback.mjs';
import { applySemanticRepeatGate } from './semantic-repeat-controller.mjs';
import { sendUnlessRecentRepeat } from './outbound-repeat-controller.mjs';

const SOCIAL_INVITATION_REQUEST = /(?:走不走|去不去|来不来|要不要(?:一起)?(?:去|来|见)|一起(?:去|走|来|吃|喝)|见面|碰面|楼见)/u;
const OWNER_ACCEPTANCE_RESPONSE = /(?:走走走|(?:^|[，。！!、\s])(?:走|去|来)(?:啊|吧|呀|哦)?(?:[，。！!、\s]|$)|好啊|可以啊?|没问题|到时(?:候)?见|待会儿见|\d+\s*楼见|马上(?:来|到|去))/u;

export function applyOwnerCommitmentGuard({
  request = '',
  response = '',
  ownerLabel = '账号本人',
} = {}) {
  const text = String(response || '');
  if (!SOCIAL_INVITATION_REQUEST.test(String(request || ''))
    || !OWNER_ACCEPTANCE_RESPONSE.test(text)) {
    return { text, guarded: false };
  }
  const owner = String(ownerLabel || '账号本人').trim() || '账号本人';
  return {
    text: `这个需要${owner}本人确认，我不能替他约定见面或行程。`,
    guarded: true,
  };
}

export async function evaluateStableResponseInbound({
  state,
  config = {},
  channel = '',
  senderId = '',
  message = {},
  metadata = {},
  text = '',
  operatorCommand = null,
  nowMs = Date.now(),
  sendClose,
  audit = () => {},
} = {}) {
  const obligation = assessResponseObligation({
    message,
    metadata,
    text,
    aliases: config.responseMentionAliases,
  });
  if (obligation.responseRequired) {
    audit('response_obligation_detected', {
      channel: String(channel || ''),
      chatId: String(message.chat_id || ''),
      senderId: String(senderId || ''),
      messageId: String(message.message_id || ''),
      reasonCode: obligation.reasonCode,
    });
  }
  const repeat = await applySemanticRepeatGate({
    state,
    enabled: config.semanticRepeatGuardEnabled,
    windowMs: config.semanticRepeatWindowMs,
    maxReplies: config.semanticRepeatMaxReplies,
    channel,
    senderId,
    message,
    text,
    operatorCommand,
    responseRequired: obligation.responseRequired,
    nowMs,
    sendClose,
    audit,
  });
  return {
    responseRequired: obligation.responseRequired,
    handled: repeat.handled === true,
    obligation,
    repeat,
  };
}

export async function generateStableResponse({
  responseRequired = false,
  generate,
  audit = () => {},
} = {}) {
  const result = await resolveRequiredResponse({ responseRequired, generate });
  if (result.fallback) {
    audit('required_response_fallback_sent', { error: 'ai_generation_error' });
  }
  return result;
}

export async function sendStableGeneratedReply({
  state,
  message = {},
  senderId = '',
  text = '',
  responseRequired = false,
  nowMs = Date.now(),
  windowMs = 10 * 60_000,
  send,
  audit = () => {},
} = {}) {
  if (typeof send !== 'function') throw new Error('Stable generated reply sender is required');
  if (String(message.chat_type || '') !== 'group') {
    const result = await send(text);
    if (result?.suppressed) return result;
    return { ...(result && typeof result === 'object' ? result : {}), sentText: text };
  }
  return sendUnlessRecentRepeat({
    state,
    chatId: message.chat_id,
    audienceKey: senderId,
    text,
    responseRequired,
    nowMs,
    windowMs,
    send,
    audit,
  });
}
