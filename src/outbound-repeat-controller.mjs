export async function sendUnlessRecentRepeat({
  state,
  chatId,
  audienceKey = '',
  text,
  nowMs = Date.now(),
  windowMs = 10 * 60_000,
  send,
  audit = () => {},
} = {}) {
  if (typeof send !== 'function') throw new Error('Outbound reply send operation is required');
  const claim = state.claimOutboundReply({
    chatId,
    audienceKey,
    content: text,
    nowMs,
    windowMs,
  });
  if (!claim.allowed) {
    audit('outbound_repeat_suppressed', {
      chatId: String(chatId || ''),
      audienceKey: String(audienceKey || ''),
      expiresAtMs: claim.expiresAtMs,
      similarity: Number(claim.similarity || 0),
      reason: String(claim.reason || ''),
    });
    return { suppressed: true, reason: 'outbound_repeat' };
  }
  try {
    const result = await send();
    if (result?.suppressed) state.releaseOutboundReplyClaim(claim.claimId);
    return result;
  } catch (error) {
    state.releaseOutboundReplyClaim(claim.claimId);
    throw error;
  }
}
