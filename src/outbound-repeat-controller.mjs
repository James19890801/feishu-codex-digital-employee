import { SEMANTIC_REPEAT_REQUIRED_ACK_REPLY } from './semantic-repeat-controller.mjs';

export async function sendUnlessRecentRepeat({
  state,
  chatId,
  audienceKey = '',
  text,
  responseRequired = false,
  nowMs = Date.now(),
  windowMs = 10 * 60_000,
  send,
  audit = () => {},
} = {}) {
  if (typeof send !== 'function') throw new Error('Outbound reply send operation is required');
  let claim;
  try {
    claim = state.claimOutboundReply({ chatId, audienceKey, content: text, nowMs, windowMs });
  } catch {
    audit('outbound_repeat_state_error', {
      chatId: String(chatId || ''),
      audienceKey: String(audienceKey || ''),
    });
    const result = await send(text);
    if (result?.suppressed) return result;
    return { ...(result && typeof result === 'object' ? result : {}), sentText: text };
  }
  const detail = {
    chatId: String(chatId || ''),
    audienceKey: String(audienceKey || ''),
    expiresAtMs: Number(claim.expiresAtMs || 0),
    similarity: Number(claim.similarity || 0),
    reason: String(claim.reason || ''),
  };
  if (!claim.allowed) {
    if (responseRequired) {
      const result = await send(SEMANTIC_REPEAT_REQUIRED_ACK_REPLY);
      if (result?.suppressed) return result;
      audit('outbound_repeat_required_acknowledged', detail);
      return {
        ...(result && typeof result === 'object' ? result : {}),
        acknowledged: true,
        reason: 'outbound_repeat',
        sentText: SEMANTIC_REPEAT_REQUIRED_ACK_REPLY,
      };
    }
    audit('outbound_repeat_suppressed', detail);
    return { suppressed: true, reason: 'outbound_repeat' };
  }
  try {
    const result = await send(text);
    if (result?.suppressed) {
      state.releaseOutboundReplyClaim(claim.claimId);
      return result;
    }
    return {
      ...(result && typeof result === 'object' ? result : {}),
      sentText: text,
    };
  } catch (error) {
    state.releaseOutboundReplyClaim(claim.claimId);
    throw error;
  }
}
