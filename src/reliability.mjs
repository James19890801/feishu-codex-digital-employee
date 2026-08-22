export function validateInboundPayload(payload) {
  const message = payload?.message;
  const sender = payload?.sender;
  if (!message?.message_id) return { ok: false, reason: 'missing message_id' };
  if (!message?.chat_id) return { ok: false, reason: 'missing chat_id' };
  if (!['group', 'p2p'].includes(message.chat_type)) return { ok: false, reason: 'invalid chat_type' };
  if (!sender?.sender_type) return { ok: false, reason: 'missing sender_type' };
  if (sender.sender_type === 'user' && !sender?.sender_id?.open_id) {
    return { ok: false, reason: 'missing sender open_id' };
  }
  return { ok: true };
}

export function interactiveInboundRateLimitPolicy(metadata = {}) {
  if (metadata?.semanticCandidate === true || metadata?.contextOnly === true) {
    return { apply: false, notify: false };
  }
  return { apply: true, notify: true };
}

export function shouldObserveWithoutReply(metadata = {}) {
  return metadata?.contextOnly === true;
}

export function finalInboundFailurePolicy() {
  return { disposition: 'dead_letter', notifyUser: false };
}

export function effectiveTask(cleanText, { messageType = 'text' } = {}) {
  const text = String(cleanText || '').trim();
  if (text) return text;
  if (messageType === 'text' || messageType === 'post') {
    return '对方只 @ 了你，没有附带问题。请自然地回应一下，并简短问对方需要什么帮助。';
  }
  return text;
}

export function isBareMention(cleanText, messageType) {
  return !String(cleanText || '').trim() && ['text', 'post'].includes(messageType);
}

export function assertCompleteSearchResult(result, channel) {
  if (result?.data?.has_more === true) {
    throw new Error(`${channel} 消息搜索未完整返回，拒绝推进轮询游标`);
  }
  if (!Array.isArray(result?.data?.messages)) {
    throw new Error(`${channel} 消息搜索返回结构无效`);
  }
  return result.data.messages;
}

export function boundedInteger(value, { name, fallback, min, max }) {
  const candidate = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(candidate) || candidate < min || candidate > max) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  return candidate;
}

export function canPerformMutation(senderOpenId, ownerOpenId) {
  return Boolean(senderOpenId) && senderOpenId === ownerOpenId;
}

export async function initializeOptionalPoller(initialize) {
  try {
    return { active: Boolean(await initialize()), error: null };
  } catch (error) {
    return { active: false, error };
  }
}

export function evaluateHealth({
  nowMs,
  cursorMs,
  maxPollAgeMs,
  processingCount,
  failedCount,
  proxyReachable = true,
}) {
  const issues = [];
  if (!Number.isFinite(cursorMs) || nowMs - cursorMs > maxPollAgeMs) {
    issues.push('poll_cursor_stale');
  }
  if (processingCount > 0) issues.push('messages_processing');
  if (failedCount > 0) issues.push('messages_failed');
  if (!proxyReachable) issues.push('codex_proxy_unreachable');
  return { healthy: issues.length === 0, issues };
}

export function countActionableInboundFailures(db, {
  overdueBefore,
  deadLetterSince = '1970-01-01T00:00:00.000Z',
} = {}) {
  if (!db || typeof db.prepare !== 'function') throw new TypeError('SQLite database is required');
  const row = db.prepare(`SELECT COUNT(*) AS count
    FROM inbound_message AS inbound
    WHERE (inbound.status = 'failed' AND inbound.available_at < ?)
      OR (inbound.status = 'dead' AND inbound.updated_at >= ?
        AND NOT EXISTS (
          SELECT 1 FROM audit AS final
          WHERE final.message_id = inbound.message_id
            AND final.event = 'inbound_failed_final'
            AND json_extract(final.detail, '$.userNotified') = 1
        ))`).get(String(overdueBefore || ''), String(deadLetterSince || ''));
  return Number(row?.count || 0);
}

export function isMulticaSyncStale({
  nowMs = Date.now(),
  lastCompletedAt = '',
  lastStartedAt = '',
  syncIntervalMs = 10_000,
  maxCycleMs = 5 * 60_000,
} = {}) {
  const now = Number(nowMs);
  const completedAtMs = Date.parse(String(lastCompletedAt || ''));
  const startedAtMs = Date.parse(String(lastStartedAt || ''));
  const freshnessMs = Math.max(60_000, Number(syncIntervalMs || 10_000) * 6);
  if (Number.isFinite(completedAtMs) && now >= completedAtMs
    && now - completedAtMs <= freshnessMs) return false;
  const inProgress = Number.isFinite(startedAtMs)
    && (!Number.isFinite(completedAtMs) || startedAtMs > completedAtMs)
    && now >= startedAtMs
    && now - startedAtMs <= Math.max(freshnessMs, Number(maxCycleMs) || 5 * 60_000);
  return !inProgress;
}

export function evaluateEventStatus(status, appId) {
  const issues = [];
  const app = Array.isArray(status?.apps)
    ? status.apps.find(item => item?.app_id === appId)
    : null;
  if (!app) issues.push('event_app_missing');
  else {
    if (app.running !== true) issues.push('event_bus_not_running');
    if (Number(app.active_consumers || 0) < 1) issues.push('event_consumer_missing');
  }
  return { healthy: issues.length === 0, issues };
}

export function planPollWindow(cursorMs, nowMs, {
  overlapMs,
  maxCatchupMs,
  maxWindowMs,
}) {
  const safeCursor = Number.isFinite(cursorMs) ? Math.min(cursorMs, nowMs) : nowMs;
  const effectiveCursor = Math.max(safeCursor, nowMs - maxCatchupMs);
  const startMs = effectiveCursor - overlapMs;
  return {
    startMs,
    endMs: Math.min(nowMs, startMs + maxWindowMs),
  };
}
