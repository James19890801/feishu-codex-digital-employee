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
  assert.equal(view.channels.feishu.healthy, true);
  assert.equal(view.channels.dingtalk.enabled, false);
  assert.equal(view.channels.wecom.enabled, false);
}

{
  const view = buildOperatorView({
    ...base,
    dingtalkChannel: {
      enabled: true,
      installed: true,
      authenticated: true,
      connected: true,
      identityMode: 'user',
      lastReadyAt: '2026-07-30T00:59:55.000Z',
    },
    wecomChannel: {
      enabled: true,
      installed: true,
      configured: true,
      authenticated: true,
      connected: true,
      identityMode: 'bot',
      lastReadyAt: '2026-07-30T00:59:55.000Z',
    },
  });
  assert.equal(view.state, 'online');
  assert.equal(view.channels.dingtalk.healthy, true);
  assert.equal(view.channels.dingtalk.identityMode, 'user');
  assert.equal(view.channels.wecom.healthy, true);
  assert.equal(view.channels.wecom.identityMode, 'bot');
}

{
  const view = buildOperatorView({
    ...base,
    dingtalkChannel: {
      enabled: true,
      installed: true,
      authenticated: false,
      connected: false,
      identityMode: 'user',
      lastError: { error: 'login required' },
    },
  });
  assert.equal(view.state, 'degraded');
  assert.equal(view.issues.includes('dingtalk_channel_unavailable'), true);
  assert.equal(view.channels.dingtalk.healthy, false);
  assert.equal(view.channels.feishu.healthy, true);
}

{
  const view = buildOperatorView({
    ...base,
    wecomChannel: {
      enabled: true,
      installed: true,
      configured: false,
      authenticated: false,
      connected: false,
      identityMode: 'bot',
      lastError: { error: 'missing bot credentials' },
    },
  });
  assert.equal(view.state, 'degraded');
  assert.equal(view.issues.includes('wecom_channel_unavailable'), true);
  assert.equal(view.channels.wecom.healthy, false);
  assert.equal(view.channels.feishu.healthy, true);
}

{
  const view = buildOperatorView({
    ...base,
    aiRuntime: {
      configured: 'auto',
      selected: 'codex',
      label: 'Codex CLI',
      available: true,
      runtimes: [
        { id: 'codex', label: 'Codex CLI', installed: true, available: true },
        { id: 'qoder', label: 'Qoder CLI', installed: true, available: true },
        { id: 'trae', label: 'TRAE', installed: true, available: false, reason: 'No headless CLI' },
      ],
    },
  });
  assert.equal(view.aiRuntime.selected, 'codex');
  assert.equal(view.aiRuntime.runtimes.length, 3);
  assert.equal(view.aiRuntime.healthy, true);
}

{
  const view = buildOperatorView({
    ...base,
    aiRuntime: {
      configured: 'auto',
      selected: 'codex',
      label: 'Codex CLI',
      available: true,
      runtimes: [],
    },
    lastAiRuntimeSuccessAt: '2026-07-30T00:58:00.000Z',
    lastAiRuntimeError: {
      at: '2026-07-30T00:59:30.000Z',
      error: 'upstream unavailable',
    },
  });
  assert.equal(view.state, 'degraded');
  assert.equal(view.issues.includes('ai_runtime_last_call_failed'), true);
  assert.equal(view.aiRuntime.healthy, false);
}

{
  const view = buildOperatorView({
    ...base,
    aiRuntime: {
      configured: 'qoder',
      selected: '',
      label: 'Qoder CLI',
      available: false,
      error: 'Qoder is not available',
      runtimes: [],
    },
  });
  assert.equal(view.state, 'degraded');
  assert.equal(view.issues.includes('ai_runtime_unavailable'), true);
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

{
  const view = buildOperatorView({
    ...base,
    multicaEnabled: true,
    lastMulticaSyncAt: '2026-07-30T00:59:55.000Z',
    maxMulticaSyncAgeMs: 60_000,
    lastMulticaSyncError: null,
    lastMulticaSyncResult: { scanned: 17, changes: 0, notified: 0 },
  });
  assert.equal(view.multica.enabled, true);
  assert.equal(view.multica.healthy, true);
  assert.equal(view.multica.scanned, 17);
}

{
  const view = buildOperatorView({
    ...base,
    multicaEnabled: true,
    lastMulticaSyncAt: '2026-07-30T00:59:55.000Z',
    maxMulticaSyncAgeMs: 60_000,
    lastMulticaSyncError: null,
    lastMulticaSyncResult: { scanned: 17, changes: 1, notified: 0, pending: 1 },
  });
  assert.equal(view.state, 'degraded');
  assert.equal(view.issues.includes('multica_delivery_pending'), true);
  assert.equal(view.multica.pending, 1);
}

{
  const view = buildOperatorView({
    ...base,
    multicaEnabled: true,
    lastMulticaSyncAt: '2026-07-30T00:59:55.000Z',
    maxMulticaSyncAgeMs: 60_000,
    lastMulticaSyncError: null,
    lastMulticaSyncResult: { scanned: 17, changes: 0, notified: 0 },
    multicaDeadCount: 1,
  });
  assert.equal(view.state, 'degraded');
  assert.equal(view.issues.includes('multica_delivery_dead'), true);
  assert.equal(view.multica.dead, 1);
}

{
  const view = buildOperatorView({
    ...base,
    backupRequired: true,
    lastBackupAt: '2026-07-29T12:00:00.000Z',
    maxBackupAgeMs: 12 * 60 * 60_000,
    lastBackupError: { error: 'disk full' },
  });
  assert.equal(view.state, 'degraded');
  assert.equal(view.issues.includes('database_backup_stale'), true);
  assert.equal(view.issues.includes('database_backup_error'), true);
  assert.equal(view.database.backupHealthy, false);
  assert.equal(view.database.healthy, false);
}

{
  const view = buildOperatorView({
    ...base,
    multicaEnabled: true,
    lastMulticaSyncAt: '2026-07-30T00:50:00.000Z',
    maxMulticaSyncAgeMs: 60_000,
    lastMulticaSyncError: { error: 'timeout' },
  });
  assert.equal(view.state, 'degraded');
  assert.equal(view.issues.includes('multica_sync_stale'), true);
  assert.equal(view.issues.includes('multica_sync_error'), true);
}

console.log('DASHBOARD_MODEL_TEST_OK');
