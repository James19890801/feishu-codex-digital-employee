const LAYER_NAMES = Object.freeze([
  'local_service',
  'tunnel',
  'public_callback',
  'provider',
  'callback_registration',
]);

const RECOVERY_BY_LAYER = Object.freeze({
  local_service: {
    action: 'reconcile_main_service',
    sequence: ['reconcile_main_service'],
  },
  tunnel: {
    action: 'reconcile_tunnel',
    sequence: ['reconcile_tunnel'],
  },
  public_callback: {
    action: 'restart_tunnel',
    sequence: ['restart_tunnel', 'align_callback'],
  },
  callback_registration: {
    action: 'align_callback',
    sequence: ['align_callback'],
  },
});

const RECOVERY_DELAYS_MS = Object.freeze([10_000, 30_000, 60_000, 120_000, 300_000]);
const FAILURE_THRESHOLD = 3;
const SUCCESS_THRESHOLD = 3;
const DESTRUCTIVE_BUDGET = 5;
const BUDGET_WINDOW_MS = 15 * 60_000;
const CIRCUIT_DURATION_MS = 15 * 60_000;

function emptyLayerState() {
  return {
    ok: null,
    lastSuccessAtMs: null,
    lastFailureAtMs: null,
    durationMs: null,
    consecutiveSuccesses: 0,
    consecutiveFailures: 0,
    errorCode: null,
  };
}

export function emptyWechatReliabilityState(nowMs = 0) {
  return {
    schemaVersion: 1,
    state: 'starting',
    checkedAtMs: Number(nowMs) || 0,
    consecutiveSuccesses: 0,
    failureLayer: null,
    recovery: null,
    recoveryAction: null,
    nextRecoveryAtMs: null,
    circuitOpenUntilMs: null,
    destructiveActionTimesMs: [],
    layers: Object.fromEntries(LAYER_NAMES.map(name => [name, emptyLayerState()])),
  };
}

function updateLayer(previous, sample, nowMs) {
  const ok = sample?.ok === true;
  const updated = {
    ok,
    lastSuccessAtMs: ok ? nowMs : previous.lastSuccessAtMs,
    lastFailureAtMs: ok ? previous.lastFailureAtMs : nowMs,
    durationMs: Number.isFinite(sample?.durationMs) ? Number(sample.durationMs) : null,
    consecutiveSuccesses: ok ? previous.consecutiveSuccesses + 1 : 0,
    consecutiveFailures: ok ? 0 : previous.consecutiveFailures + 1,
    errorCode: ok ? null : String(sample?.errorCode || 'unavailable').slice(0, 80),
  };
  if (Number.isFinite(sample?.activeConnections)) {
    updated.activeConnections = Math.max(0, Number(sample.activeConnections));
  } else if (Number.isFinite(previous?.activeConnections)) {
    updated.activeConnections = Math.max(0, Number(previous.activeConnections));
  }
  const lastRegisteredAt = String(sample?.lastRegisteredAt || previous?.lastRegisteredAt || '');
  if (Number.isFinite(Date.parse(lastRegisteredAt))) {
    updated.lastRegisteredAt = new Date(lastRegisteredAt).toISOString();
  }
  return updated;
}

export function recoveryDelayMs(attempt, random = Math.random) {
  const index = Math.max(0, Math.min(RECOVERY_DELAYS_MS.length - 1, Number(attempt) - 1 || 0));
  const randomValue = Math.max(0, Math.min(1, Number(random()) || 0));
  const jitterRatio = 0.10 + randomValue * 0.15;
  return Math.round(RECOVERY_DELAYS_MS[index] * (1 + jitterRatio));
}

export function isDestructiveRecovery(action) {
  return [
    'restart_tunnel',
    'reconcile_tunnel',
    'reconcile_main_service',
    'rollback_release',
  ].includes(String(action || ''));
}

export function evaluateWechatReliability({
  previous = emptyWechatReliabilityState(),
  sample,
  nowMs = Date.now(),
  random = Math.random,
}) {
  const checkedAtMs = Number(nowMs);
  const priorLayers = previous?.layers || emptyWechatReliabilityState().layers;
  const layers = Object.fromEntries(LAYER_NAMES.map(name => [
    name,
    updateLayer(priorLayers[name] || emptyLayerState(), sample?.layers?.[name], checkedAtMs),
  ]));
  const allHealthy = LAYER_NAMES.every(name => layers[name].ok);
  const consecutiveSuccesses = allHealthy ? Number(previous.consecutiveSuccesses || 0) + 1 : 0;
  const recentActions = (Array.isArray(previous.destructiveActionTimesMs)
    ? previous.destructiveActionTimesMs
    : []).filter(atMs => checkedAtMs - atMs < BUDGET_WINDOW_MS);

  if (allHealthy) {
    const confirmed = consecutiveSuccesses >= SUCCESS_THRESHOLD;
    return {
      ...previous,
      schemaVersion: 1,
      state: confirmed
        ? 'healthy'
        : previous.state === 'starting' ? 'starting' : 'recovering',
      checkedAtMs,
      consecutiveSuccesses,
      failureLayer: confirmed ? null : previous.failureLayer,
      recovery: null,
      nextRecoveryAtMs: confirmed ? null : previous.nextRecoveryAtMs,
      circuitOpenUntilMs: confirmed ? null : previous.circuitOpenUntilMs,
      destructiveActionTimesMs: confirmed ? [] : recentActions,
      layers,
    };
  }

  const failureLayer = LAYER_NAMES.find(name => layers[name].ok !== true);
  const failureConfirmed = layers[failureLayer].consecutiveFailures >= FAILURE_THRESHOLD;
  if (!failureConfirmed) {
    return {
      ...previous,
      schemaVersion: 1,
      state: previous.state === 'starting' ? 'starting' : previous.state,
      checkedAtMs,
      consecutiveSuccesses: 0,
      failureLayer,
      recovery: null,
      destructiveActionTimesMs: recentActions,
      layers,
    };
  }

  if (failureLayer === 'provider') {
    return {
      ...previous,
      schemaVersion: 1,
      state: 'provider_down',
      checkedAtMs,
      consecutiveSuccesses: 0,
      failureLayer,
      recovery: null,
      nextRecoveryAtMs: null,
      destructiveActionTimesMs: recentActions,
      layers,
    };
  }

  if (previous.circuitOpenUntilMs && checkedAtMs < previous.circuitOpenUntilMs) {
    return {
      ...previous,
      schemaVersion: 1,
      state: 'circuit_open',
      checkedAtMs,
      consecutiveSuccesses: 0,
      failureLayer,
      recovery: null,
      destructiveActionTimesMs: recentActions,
      layers,
    };
  }

  const recoveryDefinition = RECOVERY_BY_LAYER[failureLayer];
  if (!recoveryDefinition) {
    return {
      ...previous,
      schemaVersion: 1,
      state: 'degraded',
      checkedAtMs,
      consecutiveSuccesses: 0,
      failureLayer,
      recovery: null,
      destructiveActionTimesMs: recentActions,
      layers,
    };
  }

  if (previous.nextRecoveryAtMs && checkedAtMs < previous.nextRecoveryAtMs) {
    return {
      ...previous,
      schemaVersion: 1,
      state: 'degraded',
      checkedAtMs,
      consecutiveSuccesses: 0,
      failureLayer,
      recovery: null,
      destructiveActionTimesMs: recentActions,
      layers,
    };
  }

  const destructive = isDestructiveRecovery(recoveryDefinition.action);
  if (destructive && recentActions.length >= DESTRUCTIVE_BUDGET) {
    return {
      ...previous,
      schemaVersion: 1,
      state: 'circuit_open',
      checkedAtMs,
      consecutiveSuccesses: 0,
      failureLayer,
      recovery: null,
      nextRecoveryAtMs: null,
      circuitOpenUntilMs: checkedAtMs + CIRCUIT_DURATION_MS,
      destructiveActionTimesMs: recentActions,
      layers,
    };
  }

  const attempt = destructive ? recentActions.length + 1 : 1;
  const destructiveActionTimesMs = destructive ? [...recentActions, checkedAtMs] : recentActions;
  return {
    ...previous,
    schemaVersion: 1,
    state: 'degraded',
    checkedAtMs,
    consecutiveSuccesses: 0,
    failureLayer,
    recovery: {
      action: recoveryDefinition.action,
      attempt,
      sequence: recoveryDefinition.sequence,
    },
    recoveryAction: recoveryDefinition.action,
    nextRecoveryAtMs: destructive
      ? checkedAtMs + recoveryDelayMs(attempt, random)
      : null,
    circuitOpenUntilMs: null,
    destructiveActionTimesMs,
    layers,
  };
}
