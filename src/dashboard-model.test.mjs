import assert from 'node:assert/strict';
import {
  buildOperatorView,
  isCredentialAccessBlocked,
} from './dashboard-model.mjs';

assert.equal(isCredentialAccessBlocked({
  error: 'keychain Get failed: keychain access blocked',
}), true);
assert.equal(isCredentialAccessBlocked({
  error: 'process timed out after 45000ms',
}), false);
assert.equal(isCredentialAccessBlocked(null), false);

const base = {
  nowMs: Date.parse('2026-07-30T01:00:00.000Z'),
  processAlive: true,
  processPid: 123,
  pollCursorMs: Date.parse('2026-07-30T00:59:55.000Z'),
  maxPollAgeMs: 60_000,
  staleProcessing: 0,
  overdueFailed: 0,
  deadCount: 0,
  sqliteIntegrity: 'ok',
  lastPollSuccessAt: '2026-07-30T00:59:55.000Z',
  lastPollDurationMs: 1800,
  lastWebsocketReadyAt: '2026-07-30T00:59:50.000Z',
  websocketActive: true,
  codexProxyReachable: true,
  inboxCounts: { completed: 4 },
  recentEvents: [],
};

{
  const view = buildOperatorView(base);
  assert.equal(view.state, 'online');
  assert.equal(view.healthy, true);
  assert.equal(view.process.pid, 123);
}

{
  const view = buildOperatorView({
    ...base,
    pollCursorMs: Date.parse('2026-07-30T00:50:00.000Z'),
    websocketActive: false,
  });
  assert.equal(view.state, 'degraded');
  assert.equal(view.issues.includes('poll_cursor_stale'), true);
  assert.equal(view.issues.includes('websocket_consumer_missing'), true);
}

{
  const view = buildOperatorView({ ...base, processAlive: false });
  assert.equal(view.state, 'offline');
  assert.equal(view.healthy, false);
}

{
  const view = buildOperatorView({ ...base, credentialBlocked: true });
  assert.equal(view.state, 'degraded');
  assert.equal(view.issues.includes('credential_access_blocked'), true);
  assert.equal(view.maintenance.credentialBlocked, true);
}

console.log('DASHBOARD_MODEL_TEST_OK');
