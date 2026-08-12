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

export function shouldRecycleAiRuntime(error) {
  const message = String(error?.message || error || '');
  return message.includes('Codex CLI failed:')
    && message.includes('Operation not permitted (os error 1)');
}

export class EarliestDueScheduler {
  #timer = null;
  #dueAtMs = null;
  #stopped = false;

  constructor({ onDue, onError = error => console.error('[retry-wake-error]', error) }) {
    if (typeof onDue !== 'function') throw new Error('EarliestDueScheduler requires onDue');
    this.onDue = onDue;
    this.onError = onError;
  }

  schedule(availableAt) {
    if (this.#stopped) return false;
    if (!availableAt) {
      this.clear();
      return false;
    }
    const dueAtMs = Date.parse(availableAt);
    if (!Number.isFinite(dueAtMs)) throw new Error('Retry availableAt must be a valid timestamp');
    if (this.#timer && this.#dueAtMs <= dueAtMs) return false;
    this.clear();
    this.#dueAtMs = dueAtMs;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#dueAtMs = null;
      Promise.resolve(this.onDue()).catch(this.onError);
    }, Math.max(0, dueAtMs - Date.now()));
    this.#timer.unref?.();
    return true;
  }

  clear() {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#dueAtMs = null;
  }

  stop() {
    this.#stopped = true;
    this.clear();
  }
}

export class InboundDrainController {
  #active = null;
  #stopped = false;

  constructor({
    drain,
    nextAvailableAt,
    onError = error => console.error('[inbound-drain-error]', error),
  }) {
    if (typeof drain !== 'function') throw new Error('InboundDrainController requires drain');
    if (typeof nextAvailableAt !== 'function') {
      throw new Error('InboundDrainController requires nextAvailableAt');
    }
    this.drain = drain;
    this.nextAvailableAt = nextAvailableAt;
    this.onError = onError;
    this.scheduler = new EarliestDueScheduler({
      onDue: () => this.trigger(),
      onError,
    });
  }

  trigger(...args) {
    if (this.#stopped) return Promise.resolve();
    if (this.#active) return this.#active;
    this.scheduler.clear();
    this.#active = Promise.resolve()
      .then(() => this.drain(...args))
      .catch(this.onError)
      .finally(() => {
        this.#active = null;
        if (!this.#stopped) this.scheduler.schedule(this.nextAvailableAt());
      });
    return this.#active;
  }

  get pending() {
    return this.#active;
  }

  stop() {
    this.#stopped = true;
    this.scheduler.stop();
  }
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
