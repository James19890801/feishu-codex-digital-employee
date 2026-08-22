import assert from 'node:assert/strict';
import {
  emptyWechatReliabilityState,
  evaluateWechatReliability,
  isDestructiveRecovery,
  recoveryDelayMs,
} from './wechat-reliability-policy.mjs';

const layerNames = [
  'local_service',
  'tunnel',
  'public_callback',
  'provider',
  'callback_registration',
];

function sample(overrides = {}) {
  return {
    layers: Object.fromEntries(layerNames.map(name => [name, {
      ok: true,
      durationMs: 5,
      errorCode: null,
      ...(overrides[name] || {}),
    }])),
  };
}

function apply(previous, samples, { startMs = 1_000, stepMs = 1_000 } = {}) {
  return samples.reduce((state, current, index) => evaluateWechatReliability({
    previous: state,
    sample: current,
    nowMs: startMs + index * stepMs,
    random: () => 0,
  }), previous);
}

{
  const first = evaluateWechatReliability({
    previous: emptyWechatReliabilityState(),
    sample: sample({
      tunnel: { activeConnections: 4 },
      callback_registration: { lastRegisteredAt: '2026-08-22T12:00:00.000Z' },
    }),
    nowMs: 1_000,
    random: () => 0,
  });
  assert.equal(first.state, 'starting');
  assert.equal(first.layers.public_callback.lastSuccessAtMs, 1_000);
  assert.equal(first.layers.public_callback.consecutiveSuccesses, 1);
  assert.equal(first.layers.tunnel.activeConnections, 4);
  assert.equal(
    first.layers.callback_registration.lastRegisteredAt,
    '2026-08-22T12:00:00.000Z',
  );

  const healthy = apply(first, [sample(), sample()], { startMs: 2_000 });
  assert.equal(healthy.state, 'healthy');
  assert.equal(healthy.consecutiveSuccesses, 3);
}

{
  const failedPublic = sample({ public_callback: { ok: false, errorCode: 'http_502' } });
  const one = apply(emptyWechatReliabilityState(), [failedPublic]);
  assert.equal(one.state, 'starting');
  assert.equal(one.recovery, null);

  const two = apply(one, [failedPublic], { startMs: 2_000 });
  assert.equal(two.state, 'starting');
  assert.equal(two.recovery, null);

  const degraded = apply(two, [failedPublic], { startMs: 3_000 });
  assert.equal(degraded.state, 'degraded');
  assert.equal(degraded.failureLayer, 'public_callback');
  assert.deepEqual(degraded.recovery, {
    action: 'restart_tunnel',
    attempt: 1,
    sequence: ['restart_tunnel', 'align_callback'],
  });
  assert.equal(degraded.layers.public_callback.consecutiveFailures, 3);
  assert.equal(degraded.layers.provider.consecutiveSuccesses, 3);
}

{
  const cases = [
    ['local_service', 'reconcile_main_service', 'degraded'],
    ['tunnel', 'reconcile_tunnel', 'degraded'],
    ['callback_registration', 'align_callback', 'degraded'],
  ];
  for (const [layer, action, state] of cases) {
    const failed = sample({ [layer]: { ok: false, errorCode: 'unavailable' } });
    const evaluated = apply(emptyWechatReliabilityState(), [failed, failed, failed]);
    assert.equal(evaluated.state, state, layer);
    assert.equal(evaluated.failureLayer, layer);
    assert.equal(evaluated.recovery.action, action);
  }

  const providerFailure = sample({ provider: { ok: false, errorCode: 'account_offline' } });
  const providerDown = apply(emptyWechatReliabilityState(), [
    providerFailure,
    providerFailure,
    providerFailure,
  ]);
  assert.equal(providerDown.state, 'provider_down');
  assert.equal(providerDown.failureLayer, 'provider');
  assert.equal(providerDown.recovery, null);
}

{
  assert.equal(recoveryDelayMs(1, () => 0), 11_000);
  assert.equal(recoveryDelayMs(2, () => 0), 33_000);
  assert.equal(recoveryDelayMs(3, () => 0), 66_000);
  assert.equal(recoveryDelayMs(4, () => 0), 132_000);
  assert.equal(recoveryDelayMs(5, () => 0), 330_000);
  assert.equal(recoveryDelayMs(99, () => 1), 375_000);
  assert.equal(isDestructiveRecovery('restart_tunnel'), true);
  assert.equal(isDestructiveRecovery('reconcile_tunnel'), true);
  assert.equal(isDestructiveRecovery('reconcile_main_service'), true);
  assert.equal(isDestructiveRecovery('align_callback'), false);
}

{
  const failed = sample({ tunnel: { ok: false, errorCode: 'zero_connections' } });
  let state = emptyWechatReliabilityState();
  state = apply(state, [failed, failed, failed], { startMs: 0, stepMs: 1_000 });
  assert.equal(state.recovery.attempt, 1);
  assert.equal(state.nextRecoveryAtMs, 13_000);

  for (const nowMs of [13_000, 46_000, 112_000, 244_000]) {
    state = evaluateWechatReliability({
      previous: state,
      sample: failed,
      nowMs,
      random: () => 0,
    });
    assert.equal(state.recovery.attempt, state.destructiveActionTimesMs.length);
  }
  assert.equal(state.destructiveActionTimesMs.length, 5);

  const open = evaluateWechatReliability({
    previous: state,
    sample: failed,
    nowMs: 574_000,
    random: () => 0,
  });
  assert.equal(open.state, 'circuit_open');
  assert.equal(open.recovery, null);
  assert.ok(open.circuitOpenUntilMs > open.checkedAtMs);

  const recovered = apply(open, [sample(), sample(), sample()], {
    startMs: 575_000,
    stepMs: 1_000,
  });
  assert.equal(recovered.state, 'healthy');
  assert.equal(recovered.failureLayer, null);
  assert.equal(recovered.circuitOpenUntilMs, null);
  assert.deepEqual(recovered.destructiveActionTimesMs, []);
}

console.log('WECHAT_RELIABILITY_POLICY_TEST_OK');
