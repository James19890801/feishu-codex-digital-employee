import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { evaluateHealth } from '../src/reliability.mjs';
import { discoverAiRuntimes, selectAiRuntime } from '../src/ai-runtime.mjs';
import { evaluateLicenseGuard } from '../src/licensing/guard.mjs';
import { LicensingStore } from '../src/licensing/store.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const config = JSON.parse(readFileSync(join(root, 'config.local.json'), 'utf8'));
if (config.licensingEnforced === true) {
  const license = await evaluateLicenseGuard({
    enforced: true,
    store: new LicensingStore(),
    publicKey: String(config.licensingPublicKey || ''),
    product: String(config.licensingProductId || 'James'),
  });
  if (!license.allowed) {
    console.log(JSON.stringify({
      healthy: false,
      state: 'activation_required',
      issues: ['licensing_activation_required'],
      metrics: { licensing: { enforced: true, reason: license.reason } },
    }, null, 2));
    process.exit(2);
  }
}
const db = new DatabaseSync(join(root, 'data', 'agent-state.sqlite'), { readOnly: true });
const nowMs = Date.now();
const tcpReachable = url => new Promise(resolve => {
  if (!url) {
    resolve(true);
    return;
  }
  const target = new URL(url);
  const socket = createConnection({
    host: target.hostname,
    port: Number(target.port || (target.protocol === 'https:' ? 443 : 80)),
  });
  let settled = false;
  const finish = value => {
    if (settled) return;
    settled = true;
    socket.destroy();
    resolve(value);
  };
  socket.setTimeout(3_000, () => finish(false));
  socket.once('connect', () => finish(true));
  socket.once('error', () => finish(false));
});
const setting = (scope, key, fallback = null) => {
  const row = db.prepare('SELECT value FROM settings WHERE scope = ? AND key = ?').get(scope, key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
};

const integrity = db.prepare('PRAGMA quick_check').get()?.quick_check;
const cursorMs = Number(setting('poller', 'cursor_ms', 0));
const staleBefore = new Date(nowMs - Number(config.codexTimeoutMs || 120000) - 60_000).toISOString();
const processingCount = Number(db.prepare(`SELECT COUNT(*) AS count FROM inbound_message
  WHERE status = 'processing' AND updated_at < ?`).get(staleBefore)?.count || 0);
const failedCount = Number(db.prepare(`SELECT COUNT(*) AS count FROM inbound_message
  WHERE status = 'dead' OR (status = 'failed' AND available_at < ?)`)
  .get(new Date(nowMs - 60_000).toISOString())?.count || 0);
const a1PendingCount = Number(db.prepare(`SELECT COUNT(*) AS count
  FROM a1_notification_outbox WHERE status = 'pending'`).get()?.count || 0);
const a1DeadCount = Number(db.prepare(`SELECT COUNT(*) AS count
  FROM a1_notification_outbox WHERE status = 'dead'`).get()?.count || 0);
const proxyReachable = await tcpReachable(config.codexProxyUrl || '');
const result = evaluateHealth({
  nowMs,
  cursorMs: config.feishuEnabled === false ? nowMs : cursorMs,
  maxPollAgeMs: Math.max(60_000, Number(config.pollIntervalMs || 5000) * 12),
  processingCount,
  failedCount,
  proxyReachable,
});
let selectedAiRuntime = null;
try {
  selectedAiRuntime = selectAiRuntime(
    discoverAiRuntimes({ configuredCodexBin: config.codexBin }),
    config.aiRuntime || 'auto',
  );
} catch {
  result.issues.push('ai_runtime_unavailable');
}
if (integrity !== 'ok') result.issues.push('sqlite_integrity_failed');
const lastPollError = setting('health', 'last_poll_error', null);
const lastPollSuccessAt = setting('health', 'last_poll_success_at', '');
const lastPollDurationMs = Number(setting('health', 'last_poll_duration_ms', 0));
const lastWebsocketReadyAt = setting('health', 'last_websocket_ready_at', '');
const lastA1SyncAt = setting('health', 'last_a1_sync_at', '');
const lastA1SyncError = setting('health', 'last_a1_sync_error', null);
const lastA1SyncResult = setting('health', 'last_a1_sync_result', null);
const lastBackupAt = setting('health', 'last_database_backup_at', '');
const lastBackupError = setting('health', 'last_database_backup_error', null);
const lastAiRuntimeSuccessAt = setting('health', 'last_ai_runtime_success_at', '');
const lastAiRuntimeError = setting('health', 'last_ai_runtime_error', null);
const selfChatCircuitLast = setting('health', 'self_chat_circuit_last', null);
const lastDingTalkReconciliationSuccessAt = setting(
  'health', 'last_dingtalk_reconciliation_success_at', '',
);
const lastDingTalkReconciliationError = setting(
  'health', 'last_dingtalk_reconciliation_error', null,
);
const dingtalkChannel = setting('channel', 'dingtalk', {});
const wecomChannel = setting('channel', 'wecom', {});
const geweChannel = setting('channel', 'wechat', {});
const backupAgeMs = lastBackupAt ? nowMs - new Date(lastBackupAt).getTime() : null;
if (backupAgeMs === null || !Number.isFinite(backupAgeMs)
  || backupAgeMs > 12 * 60 * 60_000) {
  result.issues.push('database_backup_stale');
}
if (lastBackupError) result.issues.push('database_backup_error');
if (lastAiRuntimeError?.at
  && (!lastAiRuntimeSuccessAt || lastAiRuntimeError.at > lastAiRuntimeSuccessAt)) {
  result.issues.push('ai_runtime_last_call_failed');
}
if (config.feishuEnabled !== false
  && lastPollError?.at && (!lastPollSuccessAt || lastPollError.at > lastPollSuccessAt)) {
  result.issues.push('poller_last_run_failed');
}
const selfChatCircuitOpen = Number(selfChatCircuitLast?.openUntilMs || 0) > nowMs;
if (selfChatCircuitOpen) result.issues.push('self_chat_circuit_open');
if (config.dingtalkEnabled === true && !dingtalkChannel.connected) {
  result.issues.push('dingtalk_channel_unavailable');
}
let dingtalkReconciliationAgeMs = null;
if (config.dingtalkEnabled === true
  && String(config.dingtalkTransport || 'event-stream') === 'event-stream') {
  dingtalkReconciliationAgeMs = lastDingTalkReconciliationSuccessAt
    ? nowMs - new Date(lastDingTalkReconciliationSuccessAt).getTime()
    : null;
  const maxReconciliationAgeMs = Math.max(
    120_000,
    Number(config.pollIntervalMs || 5000) * 12,
  );
  if (dingtalkReconciliationAgeMs === null
    || !Number.isFinite(dingtalkReconciliationAgeMs)
    || dingtalkReconciliationAgeMs > maxReconciliationAgeMs) {
    result.issues.push('dingtalk_reconciliation_stale');
  }
  if (lastDingTalkReconciliationError?.at
    && (!lastDingTalkReconciliationSuccessAt
      || lastDingTalkReconciliationError.at > lastDingTalkReconciliationSuccessAt)) {
    result.issues.push('dingtalk_reconciliation_error');
  }
}
if (config.wecomEnabled === true && !wecomChannel.connected) {
  result.issues.push('wecom_channel_unavailable');
}
if (config.geweEnabled === true && !geweChannel.connected) {
  result.issues.push('wechat_channel_unavailable');
}
let a1SyncAgeMs = null;
if (config.a1Enabled) {
  a1SyncAgeMs = lastA1SyncAt
    ? nowMs - new Date(lastA1SyncAt).getTime()
    : null;
  const maxA1SyncAgeMs = Math.max(
    600_000,
    Number(config.a1SyncIntervalMs || 300_000) * 3,
  );
  if (a1SyncAgeMs === null || !Number.isFinite(a1SyncAgeMs)
    || a1SyncAgeMs > maxA1SyncAgeMs) {
    result.issues.push('a1_sync_stale');
  }
  if (lastA1SyncError) result.issues.push('a1_sync_error');
  if (a1PendingCount > 0) result.issues.push('a1_delivery_pending');
  if (a1DeadCount > 0) result.issues.push('a1_delivery_dead');
}
result.healthy = result.issues.length === 0;
result.metrics = {
  pollAgeMs: config.feishuEnabled === false ? null : nowMs - cursorMs,
  staleProcessing: processingCount,
  overdueFailed: failedCount,
  sqliteIntegrity: integrity,
  lastPollSuccessAt,
  lastPollDurationMs,
  lastWebsocketReadyAt,
  codexProxyReachable: proxyReachable,
  aiRuntimeConfigured: config.aiRuntime || 'auto',
  aiRuntimeSelected: selectedAiRuntime?.id || '',
  aiRuntimeLabel: selectedAiRuntime?.label || '',
  a1Enabled: config.a1Enabled === true,
  lastA1SyncAt,
  a1SyncAgeMs,
  a1Scanned: Number(lastA1SyncResult?.fetched || 0),
  a1Changes: Number(lastA1SyncResult?.changed || 0),
  a1Notified: Number(lastA1SyncResult?.delivered || 0),
  a1Pending: a1PendingCount,
  a1Failed: Number(lastA1SyncResult?.failed || 0),
  a1Dead: a1DeadCount,
  lastDatabaseBackupAt: lastBackupAt,
  databaseBackupAgeMs: backupAgeMs,
  lastAiRuntimeSuccessAt,
  selfChatCircuitOpen,
  selfChatCircuitLast,
  lastDingTalkReconciliationSuccessAt,
  dingtalkReconciliationAgeMs,
  channels: {
    feishu: {
      enabled: config.feishuEnabled !== false,
      connected: config.feishuEnabled !== false,
      state: config.feishuEnabled === false ? 'disabled' : 'connected',
      identityMode: 'user',
    },
    dingtalk: {
      enabled: config.dingtalkEnabled === true,
      installed: Boolean(dingtalkChannel.installed),
      authenticated: Boolean(dingtalkChannel.authenticated),
      connected: Boolean(dingtalkChannel.connected),
      identityMode: 'user',
    },
    wecom: {
      enabled: config.wecomEnabled === true,
      configured: Boolean(wecomChannel.configured),
      authenticated: Boolean(wecomChannel.authenticated),
      connected: Boolean(wecomChannel.connected),
      identityMode: 'bot',
    },
    wechat: {
      enabled: config.geweEnabled === true,
      configured: Boolean(geweChannel.configured),
      authenticated: Boolean(geweChannel.authenticated),
      callbackListening: Boolean(geweChannel.callbackListening),
      callbackRegistered: Boolean(geweChannel.callbackRegistered),
      connected: Boolean(geweChannel.connected),
      identityMode: 'personal-third-party',
      providerOfficial: false,
    },
  },
};
console.log(JSON.stringify(result, null, 2));
if (!result.healthy) process.exitCode = 1;
