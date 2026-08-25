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
  operator: { displayName: '新用户', role: '产品经理', brandName: '新用户的数字人' },
};

{
  const view = buildOperatorView(base);
  assert.equal(view.state, 'online');
  assert.equal(view.healthy, true);
  assert.equal(view.process.pid, 123);
  assert.equal(view.channels.feishu.healthy, true);
  assert.deepEqual(view.channels.feishu.capabilities, {
    text: true,
    image: true,
    audio: false,
    link: false,
  });
  assert.equal(view.channels.dingtalk.enabled, false);
  assert.equal(view.channels.wecom.enabled, false);
  assert.equal(view.channels.wechat.enabled, false);
  assert.deepEqual(view.operator, {
    displayName: '新用户', role: '产品经理', brandName: '新用户的数字人',
  });
}

{
  const view = buildOperatorView({
    ...base,
    webReaderEnabled: true,
    audioTranscriberAvailable: true,
    dingtalkChannel: {
      enabled: true,
      installed: true,
      authenticated: true,
      connected: true,
      identityMode: 'user',
    },
  });
  assert.deepEqual(view.channels.dingtalk.capabilities, {
    text: true,
    image: true,
    audio: true,
    link: true,
  });
  assert.deepEqual(view.channels.wecom.capabilities, {
    text: false,
    image: false,
    audio: false,
    link: false,
  });
}

{
  const view = buildOperatorView({
    ...base,
    geweChannel: {
      enabled: true,
      installed: true,
      configured: true,
      authenticated: true,
      connected: false,
      identityMode: 'personal-third-party',
      transport: 'GeWe REST + public webhook',
      lastError: { error: 'public callback is unreachable' },
    },
  });
  assert.equal(view.state, 'degraded');
  assert.equal(view.issues.includes('wechat_channel_unavailable'), true);
  assert.equal(view.channels.wechat.healthy, false);
  assert.equal(view.channels.feishu.healthy, true);
  assert.equal(view.channels.wechat.identityMode, 'personal-third-party');
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
    feishuEnabled: false,
    pollCursorMs: Number.NaN,
    websocketActive: true,
    dingtalkChannel: {
      enabled: true,
      installed: true,
      authenticated: true,
      connected: true,
      identityMode: 'user',
      lastReadyAt: '2026-07-30T00:59:55.000Z',
    },
  });
  assert.equal(view.state, 'online');
  assert.equal(view.issues.includes('poll_cursor_stale'), false);
  assert.equal(view.channels.feishu.enabled, false);
  assert.equal(view.channels.feishu.healthy, true);
  assert.equal(view.channels.feishu.transport, 'disabled');
  assert.equal(view.channels.dingtalk.healthy, true);
  assert.equal(view.primaryChannel, 'dingtalk');
  assert.equal(view.polling.applicable, false);
  assert.equal(view.polling.ageMs, null);
  assert.equal(view.websocket.lastReadyAt, '2026-07-30T00:59:55.000Z');
}

{
  const view = buildOperatorView({
    ...base,
    feishuEnabled: false,
    pollCursorMs: Number.NaN,
    websocketActive: false,
    dingtalkChannel: {
      enabled: true,
      installed: true,
      configured: true,
      authenticated: true,
      connected: true,
      identityMode: 'user',
      transport: 'Wukong DWS polling',
      lastReadyAt: '2026-07-30T00:59:58.000Z',
    },
  });
  assert.equal(view.state, 'online');
  assert.equal(view.issues.includes('websocket_consumer_missing'), false);
  assert.equal(view.channels.dingtalk.transport, 'Wukong DWS polling');
  assert.equal(view.channels.dingtalk.lastReadyAt, '2026-07-30T00:59:58.000Z');
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
    cloudFailover: {
      enabled: true,
      configured: true,
      state: 'CLOUD_ACTIVE',
      generation: 4,
      lastHeartbeatAt: '2026-07-30T00:59:30.000Z',
      lastCloudSuccessAt: '2026-07-30T00:59:35.000Z',
      lastError: null,
    },
  });
  assert.deepEqual(view.cloudFailover, {
    enabled: true,
    configured: true,
    healthy: true,
    state: 'CLOUD_ACTIVE',
    generation: 4,
    lastHeartbeatAt: '2026-07-30T00:59:30.000Z',
    lastCloudSuccessAt: '2026-07-30T00:59:35.000Z',
    lastError: null,
  });
}

{
  const view = buildOperatorView({
    ...base,
    cloudFailover: {
      enabled: true,
      configured: true,
      state: 'DEGRADED',
      generation: 5,
      lastError: { error: 'standby auth failed' },
    },
  });
  assert.equal(view.state, 'degraded');
  assert.equal(view.issues.includes('cloud_failover_degraded'), true);
  assert.equal(view.cloudFailover.healthy, false);
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
    selfChatCircuitLast: {
      chatId: 'oc_self',
      openUntilMs: base.nowMs + 60_000,
      trippedAt: '2026-07-30T00:59:30.000Z',
    },
  });
  assert.equal(view.state, 'degraded');
  assert.equal(view.issues.includes('self_chat_circuit_open'), true);
  assert.equal(view.maintenance.selfChatCircuitOpen, true);
}

{
  const view = buildOperatorView({
    ...base,
    selfChatCircuitLast: {
      chatId: 'oc_self',
      openUntilMs: base.nowMs - 1,
      trippedAt: '2026-07-30T00:57:00.000Z',
    },
  });
  assert.equal(view.issues.includes('self_chat_circuit_open'), false);
}

{
  const view = buildOperatorView({
    ...base,
    a1Enabled: true,
    lastA1SyncAt: '2026-07-30T00:59:55.000Z',
    maxA1SyncAgeMs: 600_000,
    lastA1SyncError: null,
    lastA1SyncResult: { fetched: 17, changed: 0, delivered: 0 },
  });
  assert.equal(view.a1.enabled, true);
  assert.equal(view.a1.healthy, true);
  assert.equal(view.a1.scanned, 17);
}

{
  const view = buildOperatorView({
    ...base,
    a1Enabled: true,
    lastA1SyncAt: '2026-07-30T00:59:55.000Z',
    maxA1SyncAgeMs: 600_000,
    lastA1SyncError: null,
    lastA1SyncResult: { fetched: 17, changed: 1, delivered: 0 },
    a1PendingCount: 1,
  });
  assert.equal(view.state, 'degraded');
  assert.equal(view.issues.includes('a1_delivery_pending'), true);
  assert.equal(view.a1.pending, 1);
}

{
  const view = buildOperatorView({
    ...base,
    a1Enabled: true,
    lastA1SyncAt: '2026-07-30T00:59:55.000Z',
    maxA1SyncAgeMs: 600_000,
    lastA1SyncError: null,
    lastA1SyncResult: { fetched: 17, changed: 0, delivered: 0 },
    a1DeadCount: 1,
  });
  assert.equal(view.state, 'degraded');
  assert.equal(view.issues.includes('a1_delivery_dead'), true);
  assert.equal(view.a1.dead, 1);
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
    a1Enabled: true,
    lastA1SyncAt: '2026-07-30T00:40:00.000Z',
    maxA1SyncAgeMs: 600_000,
    lastA1SyncError: { error: 'timeout' },
  });
  assert.equal(view.state, 'degraded');
  assert.equal(view.issues.includes('a1_sync_stale'), true);
  assert.equal(view.issues.includes('a1_sync_error'), true);
}

console.log('DASHBOARD_MODEL_TEST_OK');
