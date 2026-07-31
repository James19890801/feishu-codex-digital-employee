import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { evaluateHealth } from '../src/reliability.mjs';
import { discoverAiRuntimes, selectAiRuntime } from '../src/ai-runtime.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const config = JSON.parse(readFileSync(join(root, 'config.local.json'), 'utf8'));
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
const multicaDeadCount = Number(db.prepare(`SELECT COUNT(*) AS count
  FROM multica_notification_outbox WHERE status = 'dead'`).get()?.count || 0);
const proxyReachable = await tcpReachable(config.codexProxyUrl || '');
const result = evaluateHealth({
  nowMs,
  cursorMs,
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
const lastMulticaSyncAt = setting('health', 'last_multica_sync_at', '');
const lastMulticaSyncError = setting('health', 'last_multica_sync_error', null);
const lastMulticaSyncResult = setting('health', 'last_multica_sync_result', null);
const lastBackupAt = setting('health', 'last_database_backup_at', '');
const lastBackupError = setting('health', 'last_database_backup_error', null);
const lastAiRuntimeSuccessAt = setting('health', 'last_ai_runtime_success_at', '');
const lastAiRuntimeError = setting('health', 'last_ai_runtime_error', null);
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
if (lastPollError?.at && (!lastPollSuccessAt || lastPollError.at > lastPollSuccessAt)) {
  result.issues.push('poller_last_run_failed');
}
if (config.dingtalkEnabled === true && !dingtalkChannel.connected) {
  result.issues.push('dingtalk_channel_unavailable');
}
if (config.wecomEnabled === true && !wecomChannel.connected) {
  result.issues.push('wecom_channel_unavailable');
}
if (config.geweEnabled === true && !geweChannel.connected) {
  result.issues.push('wechat_channel_unavailable');
}
let multicaSyncAgeMs = null;
if (config.multicaEnabled) {
  multicaSyncAgeMs = lastMulticaSyncAt
    ? nowMs - new Date(lastMulticaSyncAt).getTime()
    : null;
  const maxMulticaSyncAgeMs = Math.max(
    60_000,
    Number(config.multicaSyncIntervalMs || 10_000) * 6,
  );
  if (multicaSyncAgeMs === null || !Number.isFinite(multicaSyncAgeMs)
    || multicaSyncAgeMs > maxMulticaSyncAgeMs) {
    result.issues.push('multica_sync_stale');
  }
  if (lastMulticaSyncError) result.issues.push('multica_sync_error');
  if (Number(lastMulticaSyncResult?.pending || 0) > 0) {
    result.issues.push('multica_delivery_pending');
  }
  if (multicaDeadCount > 0) result.issues.push('multica_delivery_dead');
}
result.healthy = result.issues.length === 0;
result.metrics = {
  pollAgeMs: nowMs - cursorMs,
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
  multicaEnabled: config.multicaEnabled === true,
  lastMulticaSyncAt,
  multicaSyncAgeMs,
  multicaScanned: Number(lastMulticaSyncResult?.scanned || 0),
  multicaChanges: Number(lastMulticaSyncResult?.changes || 0),
  multicaNotified: Number(lastMulticaSyncResult?.notified || 0),
  multicaPending: Number(lastMulticaSyncResult?.pending || 0),
  multicaFailed: Number(lastMulticaSyncResult?.failed || 0),
  multicaDead: multicaDeadCount,
  lastDatabaseBackupAt: lastBackupAt,
  databaseBackupAgeMs: backupAgeMs,
  lastAiRuntimeSuccessAt,
  channels: {
    feishu: { connected: true, identityMode: 'user' },
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
