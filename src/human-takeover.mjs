export const MINIMUM_TAKEOVER_MS = 5 * 60_000;

function normalizeControlText(text) {
  return String(text || '')
    .trim()
    .replace(/[\s\u00a0]+/g, '')
    .replace(/[。！!？?，,；;]+$/g, '');
}

function isGeneratedDingTalkCalendarCard(text) {
  const content = String(text || '');
  return content.includes('dingtalk://dingtalkclient/action/switchtab?')
    && content.includes('type=calendar')
    && content.includes('dingtalk://dingtalkclient/page/calendar_detail?uniqueId=')
    && content.split(/\r?\n/).some(line => line.trim() === '21001');
}

export function matchHumanTakeoverCommand(text) {
  const normalized = normalizeControlText(text);
  if (/^(数字人请退场|数字人停止|数字人先不要你了|暂停接管|暂停回复|我来回复)$/.test(normalized)) {
    return 'pause';
  }
  if (/^(恢复接管|恢复回复|你来回复)$/.test(normalized)) return 'resume';
  return null;
}

export function humanTakeoverStatus(value, nowMs = Date.now()) {
  if (value === true) {
    return { active: true, pausedUntilMs: Number.POSITIVE_INFINITY, remainingMs: Number.POSITIVE_INFINITY };
  }
  const pausedUntilMs = Number(value?.pausedUntilMs || 0);
  const active = Number.isFinite(pausedUntilMs) && pausedUntilMs > Number(nowMs);
  return {
    active,
    pausedUntilMs,
    remainingMs: active ? pausedUntilMs - Number(nowMs) : 0,
  };
}

export function takeoverSyncFailurePolicy({
  current = null,
  nowMs = Date.now(),
  attemptNumber = 1,
  maxAttempts = 3,
} = {}) {
  if (humanTakeoverStatus(current, nowMs).active) return 'suppress';
  return Number(attemptNumber) < Number(maxAttempts) ? 'retry' : 'proceed_degraded';
}

export function takeoverSyncFailureTerminalEvent(failurePolicy) {
  return failurePolicy === 'suppress'
    ? 'message_skipped_takeover_control_unavailable'
    : '';
}

export function activateHumanTakeover(previous, {
  nowMs = Date.now(),
  sourceMessageId = '',
  minimumMs = MINIMUM_TAKEOVER_MS,
  reason = 'owner_human_takeover',
} = {}) {
  const startedAtMs = Number(nowMs);
  const durationMs = Math.max(MINIMUM_TAKEOVER_MS, Number(minimumMs) || MINIMUM_TAKEOVER_MS);
  const previousUntilMs = Number(previous?.pausedUntilMs || 0);
  return {
    pausedAtMs: startedAtMs,
    pausedUntilMs: Math.max(previousUntilMs, startedAtMs + durationMs),
    sourceMessageId: String(sourceMessageId || ''),
    reason: String(reason || 'owner_human_takeover'),
  };
}

export function requestHumanTakeoverResume(value, nowMs = Date.now()) {
  const status = humanTakeoverStatus(value, nowMs);
  if (status.active) return { resumed: false, state: value, remainingMs: status.remainingMs };
  return { resumed: true, state: null, remainingMs: 0 };
}

export function evaluateHumanTakeover({
  current = null,
  text = '',
  authenticatedOwner = false,
  nowMs = Date.now(),
  sourceMessageId = '',
} = {}) {
  const command = authenticatedOwner ? matchHumanTakeoverCommand(text) : null;
  if (command === 'pause') {
    const state = activateHumanTakeover(current, { nowMs, sourceMessageId });
    return { command, handled: true, suppressed: true, state, resumed: false };
  }
  if (command === 'resume') {
    const result = requestHumanTakeoverResume(current, nowMs);
    return {
      command,
      handled: true,
      suppressed: !result.resumed,
      state: result.state,
      resumed: result.resumed,
    };
  }
  return {
    command: null,
    handled: false,
    suppressed: humanTakeoverStatus(current, nowMs).active,
    state: current,
    resumed: false,
  };
}

export function latestOwnerControl(messages, {
  ownerId,
  parseTime = value => Date.parse(value || ''),
} = {}) {
  const expectedOwnerId = String(ownerId || '').trim();
  if (!expectedOwnerId) return null;
  return orderedOwnerControls(messages, { ownerId: expectedOwnerId, parseTime })
    .at(-1) || null;
}

function orderedOwnerControls(messages, {
  ownerId,
  parseTime = value => Date.parse(value || ''),
} = {}) {
  const expectedOwnerId = String(ownerId || '').trim();
  if (!expectedOwnerId) return [];
  return (Array.isArray(messages) ? messages : [])
    .flatMap(message => {
      const senderId = String(
        message?.senderOpenDingTalkId
        || message?.sender_open_dingtalk_id
        || message?.sender?.id
        || '',
      ).trim();
      if (senderId !== expectedOwnerId) return [];
      const command = matchHumanTakeoverCommand(message?.content || message?.text || '');
      if (!command) return [];
      const occurredAtMs = Number(parseTime(message?.createTime || message?.create_time || ''));
      if (!Number.isFinite(occurredAtMs)) return [];
      return [{
        command,
        messageId: String(message?.openMessageId || message?.messageId || message?.message_id || ''),
        occurredAtMs,
      }];
    })
    .sort((left, right) => left.occurredAtMs - right.occurredAtMs
      || left.messageId.localeCompare(right.messageId));
}

export function applyOwnerControlHistory(messages, {
  ownerId,
  current = null,
  nowMs = Date.now(),
  parseTime,
} = {}) {
  let state = current && typeof current === 'object' ? { ...current } : current;
  const lastOccurredAtMs = Number(state?.lastControlOccurredAtMs || 0);
  const lastMessageId = String(state?.lastControlMessageId || '');
  const controls = orderedOwnerControls(messages, { ownerId, parseTime })
    .filter(control => control.occurredAtMs > lastOccurredAtMs
      || (control.occurredAtMs === lastOccurredAtMs && control.messageId > lastMessageId));

  for (const control of controls) {
    if (control.command === 'pause') {
      state = activateHumanTakeover(state, {
        nowMs: control.occurredAtMs,
        sourceMessageId: control.messageId,
      });
    } else {
      const resume = requestHumanTakeoverResume(state, control.occurredAtMs);
      state = resume.state || { pausedUntilMs: 0, reason: 'owner_human_takeover' };
    }
    state = {
      ...state,
      lastControlMessageId: control.messageId,
      lastControlOccurredAtMs: control.occurredAtMs,
    };
  }

  return {
    changed: controls.length > 0,
    controls,
    state,
    active: humanTakeoverStatus(state, nowMs).active,
  };
}

export function applyOwnerActivityHistory(messages, {
  ownerId,
  current = null,
  nowMs = Date.now(),
  parseTime = value => Date.parse(value || ''),
  isAssistantMessage = () => false,
} = {}) {
  const expectedOwnerId = String(ownerId || '').trim();
  let nextState = current && typeof current === 'object' ? { ...current } : current;
  if (!expectedOwnerId) {
    return { changed: false, activities: [], state: nextState, active: false };
  }
  const lastOccurredAtMs = Number(nextState?.lastActivityOccurredAtMs || 0);
  const lastMessageId = String(nextState?.lastActivityMessageId || '');
  const activities = (Array.isArray(messages) ? messages : [])
    .flatMap(message => {
      const senderId = String(
        message?.senderOpenDingTalkId
        || message?.sender_open_dingtalk_id
        || message?.sender?.id
        || '',
      ).trim();
      const content = message?.content || message?.text || '';
      if (senderId !== expectedOwnerId
        || isAssistantMessage(message)
        || isGeneratedDingTalkCalendarCard(content)) return [];
      const messageId = String(message?.openMessageId || message?.messageId || message?.message_id || '');
      const occurredAtMs = Number(parseTime(message?.createTime || message?.create_time || ''));
      if (!messageId || !Number.isFinite(occurredAtMs)) return [];
      return [{
        command: matchHumanTakeoverCommand(content),
        messageId,
        occurredAtMs,
      }];
    })
    .filter(activity => activity.occurredAtMs > lastOccurredAtMs
      || (activity.occurredAtMs === lastOccurredAtMs && activity.messageId > lastMessageId))
    .sort((left, right) => left.occurredAtMs - right.occurredAtMs
      || left.messageId.localeCompare(right.messageId));

  for (const activity of activities) {
    if (activity.command === 'resume') {
      const resume = requestHumanTakeoverResume(nextState, activity.occurredAtMs);
      nextState = resume.state || { pausedUntilMs: 0, reason: 'owner_manual_activity' };
    } else {
      nextState = activateHumanTakeover(nextState, {
        nowMs: activity.occurredAtMs,
        sourceMessageId: activity.messageId,
        reason: activity.command === 'pause' ? 'owner_human_takeover' : 'owner_manual_activity',
      });
    }
    nextState = {
      ...nextState,
      lastActivityMessageId: activity.messageId,
      lastActivityOccurredAtMs: activity.occurredAtMs,
    };
  }

  return {
    changed: activities.length > 0,
    activities,
    state: nextState,
    active: humanTakeoverStatus(nextState, nowMs).active,
  };
}
