import {
  takeoverReplyDisposition,
  takeoverSyncFailurePolicy,
} from './human-takeover.mjs';

export function buildOutboundLedgerMetadata(context = null) {
  const replyToMessageId = String(context?.message?.message_id || '').trim();
  return {
    outbound: true,
    ...(replyToMessageId ? { replyToMessageId } : {}),
  };
}

export function buildInboundAuditRecord(context = null, detail = {}) {
  return {
    chatId: String(context?.message?.chat_id || ''),
    senderId: String(context?.sender?.sender_id?.open_id || ''),
    messageId: String(context?.message?.message_id || ''),
    detail,
  };
}

export function buildFailureAuditDetail(error, { prefix = '' } = {}) {
  const label = String(prefix || '').trim();
  const key = suffix => label ? `${label}${suffix[0].toUpperCase()}${suffix.slice(1)}` : suffix;
  return {
    [key('error')]: String(error?.message || error || '').slice(0, 1000),
    ...(error?.code ? { [key('errorCode')]: String(error.code).slice(0, 100) } : {}),
    ...(error?.phase ? { [key('failurePhase')]: String(error.phase).slice(0, 100) } : {}),
    ...(typeof error?.retryable === 'boolean' ? { [key('retryable')]: error.retryable } : {}),
    ...(typeof error?.processRetryable === 'boolean'
      ? { [key('processRetryable')]: error.processRetryable }
      : {}),
    ...(Number.isInteger(error?.localAttempts)
      ? { [key('localAttempts')]: error.localAttempts }
      : {}),
  };
}

export function finalizeExhaustedInboundFailure({
  state,
  message,
  sender,
  source = '',
  attemptNumber = 0,
  error,
  now = new Date().toISOString(),
} = {}) {
  const processingFailure = buildFailureAuditDetail(error, { prefix: 'processing' });
  if (error?.code === 'CONVERSATION_HISTORY_UNAVAILABLE') {
    state.completeInbound(message.message_id, now);
    state.audit('message_skipped_history_unavailable', {
      ...buildInboundAuditRecord({ message, sender }, {
        source,
        attemptNumber,
        reason: 'conversation_history_unavailable',
        ...processingFailure,
        userNoticeSuppressed: true,
      }),
      createdAt: now,
    });
    return { action: 'skip', userNoticeSent: false };
  }
  state.deadLetterInbound(message.message_id, String(error || ''), now);
  state.audit('inbound_dead_lettered', {
    ...buildInboundAuditRecord({ message, sender }, {
      source,
      attemptNumber,
      ...processingFailure,
      userNoticeSuppressed: true,
    }),
    createdAt: now,
  });
  return { action: 'dead_letter', userNoticeSent: false };
}

export async function enforceInboundReplyGate({
  context = null,
  chatId = '',
  sync,
  readTakeover,
  nowMs = Date.now(),
  audit = () => {},
} = {}) {
  if (!context?.message || context.message.chat_id !== chatId) {
    return { action: 'allow', untilMs: 0, reason: 'not_inbound_reply' };
  }
  if (typeof sync !== 'function' || typeof readTakeover !== 'function') {
    throw new Error('Inbound reply gate requires takeover sync and state reader');
  }
  try {
    await sync(context.message, context.metadata || {});
  } catch (error) {
    const failurePolicy = takeoverSyncFailurePolicy({
      current: readTakeover(chatId),
      attemptNumber: context.metadata?.inboundAttemptNumber,
    });
    if (failurePolicy === 'retry') throw error;
    const disposition = {
      action: 'resolved',
      untilMs: 0,
      reason: 'takeover_control_unavailable',
    };
    audit('message_skipped_takeover_control_unavailable', context, disposition);
    return disposition;
  }
  const disposition = takeoverReplyDisposition({
    current: readTakeover(chatId),
    messageOccurredAtMs: Number(context.message.create_time || 0),
    nowMs,
  });
  if (disposition.action === 'resolved') {
    audit('message_resolved_by_owner_at_send_gate', context, disposition);
    return disposition;
  }
  if (disposition.action === 'defer') {
    audit('message_deferred_human_takeover_at_send_gate', context, disposition);
    const error = new Error('message deferred until owner cooldown expires');
    error.code = 'HUMAN_TAKEOVER_DEFERRED';
    error.retryAtMs = disposition.untilMs;
    throw error;
  }
  return disposition;
}

export function takeoverDeferralRetryAt(error, nowMs = Date.now()) {
  if (error?.code !== 'HUMAN_TAKEOVER_DEFERRED') return '';
  return new Date(Math.max(Number(nowMs) + 250, Number(error.retryAtMs || 0))).toISOString();
}
