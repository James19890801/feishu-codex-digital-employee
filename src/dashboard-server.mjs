import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.mjs';
import {
  buildOperatorView,
  isCredentialAccessBlocked,
} from './dashboard-model.mjs';
import { notificationEvent } from './notification-policy.mjs';
import { runBufferedProcess } from './process-runner.mjs';

const HOST = '127.0.0.1';
const PORT = config.dashboardPort;
const DATA_DIR = join(config.workdir, 'data');
const DB_PATH = join(DATA_DIR, 'agent-state.sqlite');
const LOCK_PATH = join(DATA_DIR, 'service.lock');
const NOTIFICATION_STATE_PATH = join(DATA_DIR, 'dashboard-notification-state.json');
const DASHBOARD_DIR = join(config.workdir, 'dashboard');
const SERVICE_LABEL = 'com.local.feishu-codex-digital-employee';
const ALLOWED_HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);

let eventCache = { checkedAt: 0, processPid: null, active: false, activeConsumers: 0 };
let eventCheckInFlight = null;
let lastNotificationState = await readFile(NOTIFICATION_STATE_PATH, 'utf8')
  .then(value => JSON.parse(value)?.state || '')
  .catch(() => '');

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function parseSetting(db, scope, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE scope = ? AND key = ?').get(scope, key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

function safeDetail(value) {
  try {
    const detail = JSON.parse(value || '{}');
    const allowed = {};
    for (const key of [
      'failures', 'delayMs', 'error', 'attemptNumber', 'retryAt',
      'fastPath', 'answerChars', 'capability', 'rateLimited',
    ]) {
      if (detail[key] !== undefined) allowed[key] = detail[key];
    }
    return allowed;
  } catch {
    return {};
  }
}

async function readProcessLock() {
  try {
    const lock = JSON.parse(await readFile(LOCK_PATH, 'utf8'));
    const pid = Number(lock.pid);
    return {
      alive: processAlive(pid),
      pid: Number.isInteger(pid) ? pid : null,
      startedAt: String(lock.startedAt || ''),
    };
  } catch {
    return { alive: false, pid: null, startedAt: '' };
  }
}

async function checkProxy() {
  if (!config.codexProxyUrl) return true;
  const target = new URL(config.codexProxyUrl);
  return new Promise(resolve => {
    const socket = createConnection({
      host: target.hostname,
      port: Number(target.port || (target.protocol === 'https:' ? 443 : 80)),
    });
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(1_500, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function refreshWebsocket(nowMs, processPid) {
  try {
    const { stdout } = await runBufferedProcess('/bin/ps', ['-axo', 'ppid=,command='], {
      timeoutMs: 2_000,
      maxStdoutBytes: 2 * 1024 * 1024,
      maxStderrBytes: 64 * 1024,
    });
    const activeConsumers = stdout.split('\n').filter(line => {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      return Number(match?.[1]) === processPid
        && /\blark-cli\s+event\s+consume\b/.test(match?.[2] || '');
    }).length;
    eventCache = {
      checkedAt: nowMs,
      processPid,
      active: activeConsumers > 0,
      activeConsumers,
    };
  } catch {
    eventCache = {
      checkedAt: nowMs,
      processPid,
      active: false,
      activeConsumers: 0,
    };
  }
}

function checkWebsocket(nowMs, processPid) {
  if (!processPid) {
    return { checkedAt: nowMs, processPid: null, active: false, activeConsumers: 0 };
  }
  if ((eventCache.processPid !== processPid || nowMs - eventCache.checkedAt >= 15_000)
    && !eventCheckInFlight) {
    eventCheckInFlight = refreshWebsocket(nowMs, processPid)
      .finally(() => { eventCheckInFlight = null; });
  }
  return eventCache.processPid === processPid
    ? eventCache
    : { checkedAt: 0, processPid, active: false, activeConsumers: 0 };
}

async function collectStatus() {
  const nowMs = Date.now();
  const processInfo = await readProcessLock();
  const websocket = checkWebsocket(nowMs, processInfo.alive ? processInfo.pid : null);
  const [codexProxyReachable] = await Promise.all([
    checkProxy(),
  ]);
  const defaults = {
    pollCursorMs: NaN,
    staleProcessing: 0,
    overdueFailed: 0,
    deadCount: 0,
    sqliteIntegrity: 'unavailable',
    lastPollSuccessAt: '',
    lastPollDurationMs: 0,
    lastPollError: null,
    lastWebsocketReadyAt: '',
    inboxCounts: {},
    recentEvents: [],
  };
  let database = defaults;
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    try {
      const counts = db.prepare('SELECT status, COUNT(*) count FROM inbound_message GROUP BY status').all();
      const staleBefore = new Date(nowMs - config.codexTimeoutMs - 60_000).toISOString();
      const failureBefore = new Date(nowMs - 60_000).toISOString();
      database = {
        pollCursorMs: Number(parseSetting(db, 'poller', 'cursor_ms', 0)),
        staleProcessing: Number(db.prepare(`SELECT COUNT(*) count FROM inbound_message
          WHERE status = 'processing' AND updated_at < ?`).get(staleBefore)?.count || 0),
        overdueFailed: Number(db.prepare(`SELECT COUNT(*) count FROM inbound_message
          WHERE status = 'failed' AND available_at < ?`).get(failureBefore)?.count || 0),
        deadCount: Number(db.prepare(`SELECT COUNT(*) count FROM inbound_message
          WHERE status = 'dead'`).get()?.count || 0),
        sqliteIntegrity: db.prepare('PRAGMA quick_check').get()?.quick_check || 'unknown',
        lastPollSuccessAt: parseSetting(db, 'health', 'last_poll_success_at', ''),
        lastPollDurationMs: Number(parseSetting(db, 'health', 'last_poll_duration_ms', 0)),
        lastPollError: parseSetting(db, 'health', 'last_poll_error', null),
        lastWebsocketReadyAt: parseSetting(db, 'health', 'last_websocket_ready_at', ''),
        inboxCounts: Object.fromEntries(counts.map(row => [row.status, Number(row.count)])),
        recentEvents: db.prepare(`SELECT event, detail, created_at
          FROM audit ORDER BY id DESC LIMIT 12`).all().map(row => ({
            event: row.event,
            at: row.created_at,
            detail: safeDetail(row.detail),
          })),
      };
    } finally {
      db.close();
    }
  } catch (error) {
    database = {
      ...defaults,
      lastPollError: { at: new Date().toISOString(), error: `database unavailable: ${error.message}` },
    };
  }

  return buildOperatorView({
    nowMs,
    processAlive: processInfo.alive,
    processPid: processInfo.pid,
    processStartedAt: processInfo.startedAt,
    maxPollAgeMs: Math.max(60_000, config.pollIntervalMs * 12),
    websocketActive: websocket.active,
    activeConsumers: websocket.activeConsumers,
    codexProxyReachable,
    credentialBlocked: isCredentialAccessBlocked(database.lastPollError),
    codexModel: config.codexModel,
    configuration: {
      allChats: config.allowAllChats,
      digitalTwinLabel: config.digitalTwinLabel,
      pollIntervalMs: config.pollIntervalMs,
      eventTransport: config.eventTransport,
    },
    ...database,
  });
}

async function notifyState(view) {
  const event = notificationEvent(lastNotificationState, view.state);
  if (lastNotificationState === view.state) return;
  lastNotificationState = view.state;
  await writeFile(NOTIFICATION_STATE_PATH, JSON.stringify({
    state: view.state,
    updatedAt: new Date().toISOString(),
  }), { mode: 0o600 }).catch(() => {});
  if (!event) return;
  const title = event === 'recovered'
    ? '数字员工已恢复'
    : event === 'partial_recovery' ? '数字员工正在恢复' : '数字员工通道断线';
  const message = event === 'recovered'
    ? '主轮询、WebSocket 和数据库已恢复正常。'
    : event === 'partial_recovery'
      ? `主进程已恢复，但仍有异常：${view.issueLabels.slice(0, 2).join('；')}`
      : view.issueLabels.slice(0, 2).join('；');
  await runBufferedProcess('/usr/bin/osascript', [
    '-e', `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`,
  ], {
    timeoutMs: 5_000,
    maxStdoutBytes: 16 * 1024,
    maxStderrBytes: 16 * 1024,
  }).catch(() => {});
}

function securityHeaders(contentType) {
  return {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, securityHeaders('application/json; charset=utf-8'));
  response.end(JSON.stringify(payload));
}

async function restartMainService() {
  await runBufferedProcess('/bin/launchctl', [
    'kickstart', '-k', `gui/${process.getuid()}/${SERVICE_LABEL}`,
  ], {
    timeoutMs: 20_000,
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 128 * 1024,
  });
}

const server = createServer(async (request, response) => {
  const host = request.headers.host || '';
  if (!ALLOWED_HOSTS.has(host)) {
    sendJson(response, 403, { ok: false, error: 'invalid host' });
    return;
  }
  const url = new URL(request.url || '/', `http://${host}`);
  try {
    if (request.method === 'GET' && staticFiles.has(url.pathname)) {
      const [file, contentType] = staticFiles.get(url.pathname);
      const content = await readFile(join(DASHBOARD_DIR, file));
      response.writeHead(200, securityHeaders(contentType));
      response.end(content);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/status') {
      sendJson(response, 200, await collectStatus());
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/restart') {
      const origin = request.headers.origin || '';
      if (!ALLOWED_HOSTS.has(origin.replace(/^http:\/\//, ''))
        || request.headers['x-dashboard-action'] !== 'restart') {
        sendJson(response, 403, { ok: false, error: 'action rejected' });
        return;
      }
      await restartMainService();
      sendJson(response, 202, { ok: true, message: 'restart requested' });
      return;
    }
    sendJson(response, 404, { ok: false, error: 'not found' });
  } catch (error) {
    console.error('[dashboard-request-error]', error);
    sendJson(response, 500, { ok: false, error: 'dashboard operation failed' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[dashboard] http://${HOST}:${PORT}`);
});

setInterval(() => {
  collectStatus().then(notifyState).catch(error => console.error('[dashboard-monitor-error]', error));
}, 30_000).unref();

collectStatus().then(notifyState).catch(() => {});
