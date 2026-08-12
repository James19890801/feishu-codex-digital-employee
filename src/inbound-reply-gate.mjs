import { takeoverReplyDisposition } from './human-takeover.mjs';

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
  await sync(context.message, context.metadata || {});
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
