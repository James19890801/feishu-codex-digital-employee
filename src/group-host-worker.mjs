function candidateReference(candidate = {}) {
  return {
    messageId: String(candidate.messageId || ''),
    chatId: String(candidate.chatId || ''),
    senderId: String(candidate.senderId || ''),
    attempts: Number(candidate.attempts || 0),
  };
}

function safeReasonCode(value, fallback = 'unspecified') {
  return String(value || fallback)
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 64) || fallback;
}

export function groupHostTransition(result = {}) {
  const action = String(result.action || 'observe');
  const reasonCode = safeReasonCode(result.reasonCode);
  if (action === 'deferred') {
    return {
      kind: 'reschedule',
      dueAtMs: Math.max(0, Number(result.dueAtMs) || 0),
      resolution: reasonCode,
    };
  }
  return {
    kind: 'complete',
    resolution: action === 'replied'
      ? 'host_replied'
      : action === 'human_picked_up'
        ? 'human_picked_up'
        : `${safeReasonCode(action, 'observe')}_${reasonCode}`.slice(0, 100),
  };
}

export function buildGroupHostHealthSnapshot({
  enabled = false,
  allowlistedGroups = 0,
  stats = {},
  iteration = {},
  previous = {},
  nowMs = Date.now(),
} = {}) {
  const checkedAt = new Date(Number(nowMs)).toISOString();
  const errorAction = ['claim_error', 'retry_error', 'retry_scheduled', 'dead_lettered']
    .includes(String(iteration.action || ''));
  return {
    enabled: enabled === true,
    allowlistedGroups: Math.max(0, Number(allowlistedGroups) || 0),
    pending: Math.max(0, Number(stats.pending) || 0),
    processing: Math.max(0, Number(stats.processing) || 0),
    completed: Math.max(0, Number(stats.completed) || 0),
    dead: Math.max(0, Number(stats.dead) || 0),
    due: Math.max(0, Number(stats.due) || 0),
    lastCheckAt: checkedAt,
    lastResolvedAt: iteration.action === 'handled'
      ? checkedAt
      : String(previous.lastResolvedAt || ''),
    lastError: errorAction
      ? { at: checkedAt, code: safeReasonCode(iteration.errorCode, 'worker_error') }
      : null,
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
    if (!retryResult?.updated) {
      return {
        action: 'retry_error',
        waitMs: 2_000,
        candidate: safeCandidate,
        errorCode: 'state_retry_error',
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
