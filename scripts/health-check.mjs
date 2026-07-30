import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { fileURLToPath } from 'node:url';
import { evaluateHealth } from '../src/reliability.mjs';

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
const proxyReachable = await tcpReachable(config.codexProxyUrl || '');
const result = evaluateHealth({
  nowMs,
  cursorMs,
  maxPollAgeMs: Math.max(60_000, Number(config.pollIntervalMs || 5000) * 12),
  processingCount,
  failedCount,
  proxyReachable,
});
if (integrity !== 'ok') result.issues.push('sqlite_integrity_failed');
const lastPollError = setting('health', 'last_poll_error', null);
const lastPollSuccessAt = setting('health', 'last_poll_success_at', '');
const lastPollDurationMs = Number(setting('health', 'last_poll_duration_ms', 0));
const lastWebsocketReadyAt = setting('health', 'last_websocket_ready_at', '');
if (lastPollError?.at && (!lastPollSuccessAt || lastPollError.at > lastPollSuccessAt)) {
  result.issues.push('poller_last_run_failed');
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
};
console.log(JSON.stringify(result, null, 2));
if (!result.healthy) process.exitCode = 1;
