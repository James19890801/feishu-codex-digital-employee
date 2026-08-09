function candidateReference(candidate = {}) {
  return {
    messageId: String(candidate.messageId || ''),
    chatId: String(candidate.chatId || ''),
    senderId: String(candidate.senderId || ''),
    attempts: Number(candidate.attempts || 0),
  };
}

export function redactGroupHostError(error, stage = 'process') {
  if (stage === 'claim') return 'state_claim_error';
  if (stage === 'retry') return 'state_retry_error';
  const code = String(error?.code || '').toUpperCase();
  if (code === 'PROCESS_TIMEOUT') return 'process_timeout';
  if (code === 'PROCESS_OUTPUT_LIMIT') return 'process_output_limit';
  const message = String(error?.message || '');
  if (/classifier budget exhausted/i.test(message)) return 'classifier_budget_exhausted';
  if (/channel is not available|channel unavailable/i.test(message)) return 'channel_unavailable';
  return 'group_host_processing_error';
}

export async function runGroupHostWorkerIteration({
  nowMs = Date.now(),
  claim,
  handle,
  retry,
  maxAttempts = 3,
} = {}) {
  let candidate;
  try {
    candidate = await claim(Number(nowMs));
  } catch (error) {
    return {
      action: 'claim_error',
      waitMs: 2_000,
      errorCode: redactGroupHostError(error, 'claim'),
    };
  }
  if (!candidate) return { action: 'idle', waitMs: 1_000 };
  const safeCandidate = candidateReference(candidate);
  try {
    const result = await handle(candidate);
    return {
      action: 'handled',
      waitMs: 0,
      candidate: safeCandidate,
      handledAction: String(result?.action || ''),
      reasonCode: String(result?.reasonCode || '').slice(0, 100),
    };
  } catch (error) {
    const errorCode = redactGroupHostError(error, 'process');
    const retryAtMs = Number(nowMs) + Math.min(
      60_000,
      15_000 * (2 ** Math.max(0, safeCandidate.attempts - 1)),
    );
    let retryResult;
    try {
      retryResult = await retry(
        safeCandidate.messageId,
        errorCode,
        retryAtMs,
        Number(nowMs),
        Math.max(1, Number(maxAttempts) || 3),
      );
    } catch (retryError) {
      return {
        action: 'retry_error',
        waitMs: 2_000,
        candidate: safeCandidate,
        errorCode: redactGroupHostError(retryError, 'retry'),
      };
    }
    return {
      action: retryResult?.deadLettered ? 'dead_lettered' : 'retry_scheduled',
      waitMs: 0,
      candidate: safeCandidate,
      errorCode,
      retryAtMs,
      attempts: Number(retryResult?.attempts || safeCandidate.attempts),
    };
  }
}
