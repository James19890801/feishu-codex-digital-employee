export async function sendUnlessRecentRepeat({
  state,
  chatId,
  audienceKey = '',
  text,
  nowMs = Date.now(),
  windowMs = 10 * 60_000,
  suppressRepeats = true,
  send,
  audit = () => {},
} = {}) {
  if (typeof send !== 'function') throw new Error('Outbound reply send operation is required');
  // One-to-one conversations are required-response surfaces. A repeated answer
  // can still be the correct answer to a repeated question, so never turn the
  // group anti-spam guard into a silent direct-message drop.
  if (suppressRepeats === false) return send();
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
