const KINDS = new Set([
  'task',
  'calendar',
  'task_batch',
  'multica',
  'multica_feedback',
  'multica_create_route',
]);

function revive(kind, value) {
  if (!value) return value;
  if (kind === 'task') {
    return { ...value, due: value.due ? new Date(value.due) : null };
  }
  if (kind === 'calendar') {
    return {
      ...value,
      start: value.start ? new Date(value.start) : null,
      end: value.end ? new Date(value.end) : null,
    };
  }
  if (kind === 'task_batch') {
    return {
      ...value,
      items: (value.items || []).map(item => ({ ...item, due: item.due ? new Date(item.due) : null })),
    };
  }
  return value;
}

export class PendingActionStore {
  constructor(state, { ttlMs = 24 * 60 * 60_000 } = {}) {
    this.state = state;
    this.ttlMs = ttlMs;
  }

  key(kind, chatId, senderId) {
    if (!KINDS.has(kind)) throw new Error(`unsupported pending action kind: ${kind}`);
    return `${kind}:${chatId}:${senderId}`;
  }

  set(kind, chatId, senderId, value, nowMs = Date.now()) {
    this.state.set('pending_action', this.key(kind, chatId, senderId), {
      expiresAt: nowMs + this.ttlMs,
      value,
    });
  }

  get(kind, chatId, senderId, nowMs = Date.now()) {
    const key = this.key(kind, chatId, senderId);
    const stored = this.state.get('pending_action', key, null);
    if (!stored) return null;
    if (!Number.isFinite(stored.expiresAt) || stored.expiresAt <= nowMs) {
      this.state.unset('pending_action', key);
      return null;
    }
    return revive(kind, stored.value);
  }

  delete(kind, chatId, senderId) {
    this.state.unset('pending_action', this.key(kind, chatId, senderId));
  }
}
