import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { config } from './config.mjs';
import {
  applyChangePlan,
  assertPlanMatchesDocuments,
  buildPlannerPrompt,
  createChangePlan,
  effectivePublicConfiguration,
  parsePlannerOutput,
  publicConfiguration,
} from './config-assistant.mjs';
import {
  appendConfigurationAudit,
  createConfigurationSnapshot,
  listConfigurationSnapshots,
  readConfigurationDocuments,
  restoreConfigurationSnapshot,
  writeConfigurationDocuments,
} from './config-store.mjs';
import { PendingConfigurationPlans } from './pending-config-plans.mjs';
import {
  isAllowedDashboardAction,
  parseDashboardJson,
} from './dashboard-api-security.mjs';
import {
  channelConfigurationView,
  channelConnectionReport,
  channelCredentialTarget,
  mainServiceReadyForChannelChange,
  normalizeChannelConfigurationRequest,
} from './channel-configuration.mjs';
import {
  keychainCredentialExists,
  replaceKeychainCredential,
} from './channel-credentials.mjs';
import {
  buildOperatorView,
  isCredentialAccessBlocked,
} from './dashboard-model.mjs';
import { notificationEvent } from './notification-policy.mjs';
import { runBufferedProcess } from './process-runner.mjs';
import { SerialKeyQueue } from './serial-key-queue.mjs';
import {
  AiRuntimeClient,
  discoverAiRuntimes,
  selectAiRuntime,
} from './ai-runtime.mjs';
import { createLicensingFetch, LicensingClient } from './licensing/client.mjs';
import { LicensingDashboardApi } from './licensing/dashboard-api.mjs';
import { LicensingStore } from './licensing/store.mjs';

const HOST = '127.0.0.1';
const PORT = config.dashboardPort;
const DATA_DIR = join(config.workdir, 'data');
const DB_PATH = join(DATA_DIR, 'agent-state.sqlite');
const LOCK_PATH = join(DATA_DIR, 'service.lock');
const NOTIFICATION_STATE_PATH = join(DATA_DIR, 'dashboard-notification-state.json');
const DASHBOARD_DIR = join(config.workdir, 'dashboard');
const CONFIG_ASSISTANT_RUNTIME_DIR = join(DATA_DIR, 'config-assistant-runtime');
const CONFIG_ASSISTANT_CODEX_HOME = join(DATA_DIR, 'codex-home');
const CONFIG_ASSISTANT_SESSION_TOKEN = randomBytes(32).toString('hex');
const INITIAL_PUBLIC_CONFIGURATION = publicConfiguration(config);
const SERVICE_LABEL = 'com.local.feishu-codex-digital-employee';
const ALLOWED_HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
const licensingStore = new LicensingStore();
const licensingFetch = createLicensingFetch({ proxyUrl: config.licensingProxyUrl });
const licensingClient = config.licensingServiceUrl
  ? new LicensingClient({ serviceUrl: config.licensingServiceUrl, fetchImpl: licensingFetch })
  : null;
const licensingApi = new LicensingDashboardApi({
  store: licensingStore,
  client: licensingClient,
  publicKey: config.licensingPublicKey,
  product: config.licensingProductId,
  enforced: config.licensingEnforced,
});
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/config-ui.js', ['config-ui.js', 'text/javascript; charset=utf-8']],
  ['/i18n.js', ['i18n.js', 'text/javascript; charset=utf-8']],
  ['/licensing-ui.js', ['licensing-ui.js', 'text/javascript; charset=utf-8']],
]);

let eventCache = { checkedAt: 0, processPid: null, active: false, activeConsumers: 0 };
let eventCheckInFlight = null;
const pendingConfigurationPlans = new PendingConfigurationPlans();
const configurationMutationQueue = new SerialKeyQueue();
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

function tableExists(db, name) {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name));
}

function readSemanticRepeatDashboardState(db, nowMs) {
  if (!tableExists(db, 'semantic_repeat_guard')) {
    return { activeTopics: 0, totalSuppressed: 0, latestSuppression: null };
  }
  const aggregate = db.prepare(`SELECT
      SUM(CASE WHEN expires_at_ms > ? THEN 1 ELSE 0 END) AS active_topics,
      COALESCE(SUM(suppressed_count), 0) AS total_suppressed
    FROM semantic_repeat_guard`).get(nowMs);
  const latest = db.prepare(`SELECT channel, chat_id, sender_id, last_seen_ms,
      reply_count, suppressed_count, last_similarity
    FROM semantic_repeat_guard WHERE last_action = 'suppress'
    ORDER BY last_seen_ms DESC LIMIT 1`).get();
  return {
    activeTopics: Number(aggregate?.active_topics || 0),
    totalSuppressed: Number(aggregate?.total_suppressed || 0),
    latestSuppression: latest ? {
      channel: latest.channel,
      chatId: latest.chat_id,
      senderId: latest.sender_id,
      at: new Date(Number(latest.last_seen_ms)).toISOString(),
      count: Number(latest.reply_count),
      suppressedCount: Number(latest.suppressed_count),
      similarity: Number(latest.last_similarity),
    } : null,
  };
}

function readSemanticGroupDashboardState(db) {
  const rows = db.prepare(`SELECT detail FROM audit
    WHERE event = 'semantic_group_engagement_decided'
    ORDER BY id DESC LIMIT 10000`).all();
  const localReasons = new Set([
    'disabled', 'non_group', 'unsupported_or_empty', 'human_takeover',
    'explicit_mention', 'addressed_other', 'assistant_alias', 'low_information',
    'recent_assistant_exchange', 'entry_cooldown', 'ambient_chatter',
  ]);
  const counts = { observed: rows.length, classified: 0, replied: 0, suppressed: 0 };
  for (const row of rows) {
    let detail = {};
    try { detail = JSON.parse(row.detail || '{}'); } catch { detail = {}; }
    const action = String(detail.action || '');
    const reasonCode = String(detail.reasonCode || '');
    if (action === 'reply_semantic' || (!localReasons.has(reasonCode) && reasonCode)) {
      counts.classified += 1;
    }
    if (action.startsWith('reply_')) counts.replied += 1;
    else counts.suppressed += 1;
  }
  return {
    ...counts,
    lastError: parseSetting(db, 'health', 'last_enterpriseChat_semantic_poll_error', null),
  };
}

function readDiscussionDashboardState(db, nowMs) {
  if (!tableExists(db, 'discussion_session')) {
    return { activeSessions: 0, coolingSessions: 0, closedSessions: 0, latestClosure: null };
  }
  const aggregate = db.prepare(`SELECT
      SUM(CASE WHEN status IN ('active', 'finalizing') THEN 1 ELSE 0 END) AS active_sessions,
      SUM(CASE WHEN status = 'cooldown' AND cooldown_until_ms > ? THEN 1 ELSE 0 END) AS cooling_sessions,
      COALESCE(SUM(closed_count), 0) AS closed_sessions
    FROM discussion_session`).get(nowMs);
  const latest = db.prepare(`SELECT channel, chat_id, session_no, reply_count,
      closure_reason, last_seen_ms, cooldown_until_ms
    FROM discussion_session WHERE closure_reason <> ''
    ORDER BY last_seen_ms DESC LIMIT 1`).get();
  return {
    activeSessions: Number(aggregate?.active_sessions || 0),
    coolingSessions: Number(aggregate?.cooling_sessions || 0),
    closedSessions: Number(aggregate?.closed_sessions || 0),
    latestClosure: latest ? {
      channel: latest.channel,
      chatId: latest.chat_id,
      sessionNo: Number(latest.session_no),
      replyCount: Number(latest.reply_count),
      reason: latest.closure_reason,
      at: new Date(Number(latest.last_seen_ms)).toISOString(),
      cooldownUntil: latest.cooldown_until_ms
        ? new Date(Number(latest.cooldown_until_ms)).toISOString()
        : '',
    } : null,
  };
}

function readLearningDashboardState(db) {
  const settingStatus = parseSetting(db, 'learning', 'status', { state: 'scheduled' });
  const manualRequestedAt = parseSetting(db, 'learning', 'manual_requested_at', '');
  const base = {
    enabled: config.dailyLearningEnabled,
    scheduledHour: config.dailyLearningHour,
    status: settingStatus?.state === 'running'
      ? 'running'
      : manualRequestedAt ? 'queued' : String(settingStatus?.state || 'scheduled'),
    stage: String(settingStatus?.stage || ''),
    nextRunAt: parseSetting(db, 'learning', 'next_run_at', ''),
    manualRequestedAt,
    totals: { completed: 0, tasks: 0, skills: 0, errors: 0 },
    recentRuns: [],
  };
  if (!tableExists(db, 'learning_run') || !tableExists(db, 'learning_item')) return base;
  const totals = db.prepare(`SELECT COUNT(*) AS completed,
    COALESCE(SUM(tasks_learned), 0) AS tasks,
    COALESCE(SUM(skills_learned), 0) AS skills,
    COALESCE(SUM(errors_learned), 0) AS errors
    FROM learning_run WHERE status='completed'`).get();
  const rows = db.prepare(`SELECT id, learning_date, status, started_at, completed_at,
    files_scanned, chats_reviewed, tasks_learned, skills_learned, errors_learned,
    summary, error FROM learning_run ORDER BY learning_date DESC LIMIT 14`).all();
  const itemQuery = db.prepare(`SELECT category, title, lesson FROM learning_item
    WHERE run_id=? ORDER BY id ASC LIMIT 12`);
  return {
    ...base,
    totals: {
      completed: Number(totals?.completed || 0),
      tasks: Number(totals?.tasks || 0),
      skills: Number(totals?.skills || 0),
      errors: Number(totals?.errors || 0),
    },
    recentRuns: rows.map(row => ({
      id: row.id,
      learningDate: row.learning_date,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      filesScanned: Number(row.files_scanned || 0),
      chatsReviewed: Number(row.chats_reviewed || 0),
      tasksLearned: Number(row.tasks_learned || 0),
      skillsLearned: Number(row.skills_learned || 0),
      errorsLearned: Number(row.errors_learned || 0),
      summary: String(row.summary || '').slice(0, 4000),
      error: String(row.error || '').slice(0, 500),
      items: itemQuery.all(row.id).map(item => ({
        category: item.category,
        title: String(item.title || '').slice(0, 200),
        lesson: String(item.lesson || '').slice(0, 1000),
      })),
    })),
  };
}

function requestDailyLearning() {
  const requestedAt = new Date().toISOString();
  const db = new DatabaseSync(DB_PATH);
  try {
    if (!tableExists(db, 'settings') || !tableExists(db, 'audit')) {
      throw new Error('AIPRO state database is not initialized');
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const upsert = db.prepare(`INSERT INTO settings(scope,key,value,updated_at)
        VALUES('learning',?,?,?) ON CONFLICT(scope,key) DO UPDATE SET
        value=excluded.value, updated_at=excluded.updated_at`);
      upsert.run('manual_requested_at', JSON.stringify(requestedAt), requestedAt);
      upsert.run('status', JSON.stringify({ state: 'queued', requestedAt }), requestedAt);
      db.prepare(`INSERT INTO audit(event,message_id,chat_id,sender_id,detail,created_at)
        VALUES('daily_learning_manual_requested','','','',?,?)`)
        .run(JSON.stringify({ reason: 'manual' }), requestedAt);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
  return requestedAt;
}

function safeDetail(value) {
  try {
    const detail = JSON.parse(value || '{}');
    const allowed = {};
    for (const key of [
      'failures', 'delayMs', 'error', 'attemptNumber', 'retryAt',
      'fastPath', 'answerChars', 'capability', 'rateLimited',
      'action', 'identifier', 'issueId', 'workspaceId', 'changedFields',
      'recipients', 'changes', 'notified', 'scanned',
      'dead', 'replayed', 'uncertain', 'channel',
      'learningDate', 'reason', 'filesScanned', 'chatsReviewed',
      'tasksLearned', 'skillsLearned', 'errorsLearned',
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
        && /(?:\blark-cli\s+event\s+consume\b|\bconnector\b.*\bevent\s+consume\b)/
          .test(match?.[2] || '');
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
  const aiRuntime = currentAiRuntimeState();
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
    lastMulticaSyncAt: '',
    lastMulticaSyncError: null,
    lastMulticaSyncResult: null,
    multicaDeadCount: 0,
    lastBackupAt: '',
    lastBackupError: null,
    lastAiRuntimeSuccessAt: '',
    lastAiRuntimeError: null,
    selfChatCircuitLast: null,
    semanticRepeat: { activeTopics: 0, totalSuppressed: 0, latestSuppression: null },
    semanticGroupEngagement: {
      observed: 0, classified: 0, replied: 0, suppressed: 0, lastError: null,
    },
    discussion: { activeSessions: 0, coolingSessions: 0, closedSessions: 0, latestClosure: null },
    enterpriseChatChannel: {
      enabled: config.enterpriseChatEnabled,
      installed: existsSync(config.enterpriseChatBin),
      configured: existsSync(config.enterpriseChatBin),
      authenticated: false,
      connected: false,
      identityMode: 'user',
    },
    wecomChannel: {
      enabled: config.wecomEnabled,
      installed: true,
      configured: Boolean(config.wecomBotId),
      authenticated: false,
      connected: false,
      identityMode: 'bot',
    },
    geweChannel: {
      enabled: config.geweEnabled,
      installed: true,
      configured: Boolean(config.geweAppId && config.gewePublicCallbackBaseUrl),
      authenticated: false,
      connected: false,
      callbackListening: false,
      identityMode: 'personal-third-party',
      transport: 'GeWe REST + public webhook',
    },
    inboxCounts: {},
    recentEvents: [],
    learning: {
      enabled: config.dailyLearningEnabled,
      scheduledHour: config.dailyLearningHour,
      status: 'scheduled',
      stage: '',
      nextRunAt: '',
      manualRequestedAt: '',
      totals: { completed: 0, tasks: 0, skills: 0, errors: 0 },
      recentRuns: [],
    },
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
        lastMulticaSyncAt: parseSetting(db, 'health', 'last_multica_sync_at', ''),
        lastMulticaSyncError: parseSetting(db, 'health', 'last_multica_sync_error', null),
        lastMulticaSyncResult: parseSetting(db, 'health', 'last_multica_sync_result', null),
        multicaDeadCount: Number(db.prepare(`SELECT COUNT(*) count
          FROM multica_notification_outbox WHERE status = 'dead'`).get()?.count || 0),
        lastBackupAt: parseSetting(db, 'health', 'last_database_backup_at', ''),
        lastBackupError: parseSetting(db, 'health', 'last_database_backup_error', null),
        lastAiRuntimeSuccessAt: parseSetting(db, 'health', 'last_ai_runtime_success_at', ''),
        lastAiRuntimeError: parseSetting(db, 'health', 'last_ai_runtime_error', null),
        selfChatCircuitLast: parseSetting(db, 'health', 'self_chat_circuit_last', null),
        semanticRepeat: readSemanticRepeatDashboardState(db, nowMs),
        semanticGroupEngagement: readSemanticGroupDashboardState(db),
        discussion: readDiscussionDashboardState(db, nowMs),
        enterpriseChatChannel: {
          ...defaults.enterpriseChatChannel,
          ...parseSetting(db, 'channel', 'enterpriseChat', {}),
          installed: existsSync(config.enterpriseChatBin),
        },
        wecomChannel: {
          ...defaults.wecomChannel,
          ...parseSetting(db, 'channel', 'wecom', {}),
          installed: true,
          configured: Boolean(config.wecomBotId),
        },
        geweChannel: {
          ...defaults.geweChannel,
          ...parseSetting(db, 'channel', 'wechat', {}),
          installed: true,
          configured: Boolean(config.geweAppId && config.gewePublicCallbackBaseUrl),
        },
        inboxCounts: Object.fromEntries(counts.map(row => [row.status, Number(row.count)])),
        recentEvents: db.prepare(`SELECT event, detail, created_at
          FROM audit ORDER BY id DESC LIMIT 12`).all().map(row => ({
            event: row.event,
            at: row.created_at,
            detail: safeDetail(row.detail),
          })),
        learning: readLearningDashboardState(db),
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

  const view = buildOperatorView({
    nowMs,
    processAlive: processInfo.alive,
    processPid: processInfo.pid,
    processStartedAt: processInfo.startedAt,
    feishuEnabled: config.feishuEnabled,
    maxPollAgeMs: Math.max(60_000, config.pollIntervalMs * 12),
    websocketActive: websocket.active,
    activeConsumers: websocket.activeConsumers,
    codexProxyReachable,
    credentialBlocked: isCredentialAccessBlocked(database.lastPollError),
    codexModel: config.codexModel,
    webReaderEnabled: config.webReaderEnabled,
    audioTranscriberAvailable: Boolean(
      config.audioTranscriptionCommand && existsSync(config.audioTranscriptionCommand)
    ),
    aiRuntime,
    multicaEnabled: config.multicaEnabled,
    maxMulticaSyncAgeMs: Math.max(60_000, config.multicaSyncIntervalMs * 6),
    backupRequired: true,
    maxBackupAgeMs: 12 * 60 * 60_000,
    semanticRepeatGuardEnabled: config.semanticRepeatGuardEnabled,
    semanticRepeatWindowMs: config.semanticRepeatWindowMs,
    semanticRepeatMaxReplies: config.semanticRepeatMaxReplies,
    semanticGroupEngagementEnabled: config.semanticGroupEngagementEnabled,
    semanticGroupReplyThreshold: config.semanticGroupReplyThreshold,
    semanticGroupEntryCooldownMs: config.semanticGroupEntryCooldownMs,
    adaptiveDiscussionEnabled: config.adaptiveDiscussionEnabled,
    adaptiveDiscussionMaxReplies: config.adaptiveDiscussionMaxReplies,
    adaptiveDiscussionLowValueLimit: config.adaptiveDiscussionLowValueLimit,
    adaptiveDiscussionCooldownMs: config.adaptiveDiscussionCooldownMs,
    configuration: {
      allChats: config.allowAllChats,
      digitalTwinLabel: config.digitalTwinLabel,
      pollIntervalMs: config.pollIntervalMs,
      eventTransport: config.eventTransport,
      aiRuntime: config.aiRuntime,
      enterpriseChatEnabled: config.enterpriseChatEnabled,
      enterpriseChatProfile: config.enterpriseChatProfile,
      wecomEnabled: config.wecomEnabled,
      wecomBotId: config.wecomBotId,
      geweEnabled: config.geweEnabled,
      geweAppId: config.geweAppId,
      gewePublicCallbackBaseUrl: config.gewePublicCallbackBaseUrl,
      geweCallbackPort: config.geweCallbackPort,
      geweMentionNames: config.geweMentionNames,
      multicaEnabled: config.multicaEnabled,
      multicaProfile: config.multicaProfile,
      multicaDefaultWorkspaceId: config.multicaDefaultWorkspaceId,
      multicaSyncIntervalMs: config.multicaSyncIntervalMs,
      semanticRepeatGuardEnabled: config.semanticRepeatGuardEnabled,
      semanticRepeatWindowMs: config.semanticRepeatWindowMs,
      semanticRepeatMaxReplies: config.semanticRepeatMaxReplies,
      semanticGroupEngagementEnabled: config.semanticGroupEngagementEnabled,
      semanticGroupReplyThreshold: config.semanticGroupReplyThreshold,
      semanticGroupEntryCooldownMs: config.semanticGroupEntryCooldownMs,
      semanticGroupAliases: config.semanticGroupAliases,
      adaptiveDiscussionEnabled: config.adaptiveDiscussionEnabled,
      adaptiveDiscussionMaxReplies: config.adaptiveDiscussionMaxReplies,
      adaptiveDiscussionLowValueLimit: config.adaptiveDiscussionLowValueLimit,
      adaptiveDiscussionCooldownMs: config.adaptiveDiscussionCooldownMs,
    },
    ...database,
  });
  view.learning = database.learning;
  return view;
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
    ? 'AIPRO 已恢复'
    : event === 'partial_recovery' ? 'AIPRO 正在恢复' : 'AIPRO 通道断线';
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

async function readDashboardJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw new Error('Dashboard request body is too large');
    chunks.push(chunk);
  }
  return parseDashboardJson(Buffer.concat(chunks).toString('utf8'));
}

function allowedConfigAction(request, expectedAction) {
  return isAllowedDashboardAction({
    host: request.headers.host || '',
    origin: request.headers.origin || '',
    action: request.headers['x-dashboard-action'] || '',
    expectedAction,
    token: request.headers['x-dashboard-session'] || '',
    expectedToken: CONFIG_ASSISTANT_SESSION_TOKEN,
    allowedHosts: ALLOWED_HOSTS,
  });
}

function plannerEnvironment() {
  const env = {
    ...process.env,
    CODEX_HOME: CONFIG_ASSISTANT_CODEX_HOME,
  };
  if (config.codexProxyUrl) {
    env.HTTP_PROXY = config.codexProxyUrl;
    env.HTTPS_PROXY = config.codexProxyUrl;
    env.ALL_PROXY = config.codexProxyUrl;
  }
  return env;
}

function currentAiRuntimeState() {
  const runtimes = discoverAiRuntimes({ configuredCodexBin: config.codexBin });
  let selected = null;
  let error = '';
  try {
    selected = selectAiRuntime(runtimes, config.aiRuntime);
  } catch (failure) {
    error = String(failure?.message || failure);
  }
  return {
    configured: config.aiRuntime,
    selected: selected?.id || '',
    label: selected?.label || '',
    available: Boolean(selected),
    error,
    runtimes: runtimes.map(item => ({
      id: item.id,
      label: item.label,
      description: item.description,
      installed: item.installed,
      available: item.available,
      selected: item.id === selected?.id,
      supportsImages: item.supportsImages,
      reason: item.reason,
    })),
  };
}

async function runConfigurationPlanner(prompt, documents) {
  const runtimeState = currentAiRuntimeState();
  const runtime = selectAiRuntime(
    discoverAiRuntimes({ configuredCodexBin: config.codexBin }),
    runtimeState.selected,
  );
  const client = new AiRuntimeClient({
    runtime,
    env: plannerEnvironment(),
  });
  return client.run(prompt, {
    cwd: CONFIG_ASSISTANT_RUNTIME_DIR,
    model: runtime.id === 'codex'
      ? documents.config.codexModel || config.codexModel
      : '',
    timeoutMs: Math.min(config.codexTimeoutMs, 120_000),
    maxStdoutBytes: 512 * 1024,
    maxStderrBytes: 1024 * 1024,
  });
}

async function readEffectiveConfigurationDocuments() {
  const documents = await readConfigurationDocuments(config.workdir);
  return {
    ...documents,
    config: {
      ...INITIAL_PUBLIC_CONFIGURATION,
      ...documents.config,
    },
  };
}

async function createConfigurationAssistantPlan(requestText) {
  const documents = await readEffectiveConfigurationDocuments();
  const prompt = buildPlannerPrompt({ request: requestText, documents });
  await Promise.all([
    mkdir(CONFIG_ASSISTANT_RUNTIME_DIR, { recursive: true, mode: 0o700 }),
    mkdir(CONFIG_ASSISTANT_CODEX_HOME, { recursive: true, mode: 0o700 }),
  ]);
  const { text } = await runConfigurationPlanner(prompt, documents);
  const proposal = parsePlannerOutput(text);
  const plan = createChangePlan(proposal, documents, {
    id: `plan-${Date.now()}-${randomUUID().slice(0, 8)}`,
  });
  const confirmationCode = plan.confirmationLevel === 'double'
    ? String(randomInt(100000, 1000000))
    : '';
  const pending = pendingConfigurationPlans.add(plan, { confirmationCode });
  await appendConfigurationAudit(config.workdir, {
    event: 'configuration_plan_created',
    planId: plan.id,
    summary: plan.summary,
    confirmationLevel: plan.confirmationLevel,
    changes: plan.changes.map(change => ({
      target: change.target,
      key: change.key || '',
      label: change.label,
    })),
  });
  return pending;
}

async function createRuntimeSelectionPlan(runtimeId) {
  const requested = String(runtimeId || '');
  if (!['auto', 'codex', 'qoder', 'codebuddy', 'trae'].includes(requested)) {
    throw new Error('Unknown AI runtime selection');
  }
  const runtimeState = currentAiRuntimeState();
  if (requested !== 'auto') {
    const runtime = runtimeState.runtimes.find(item => item.id === requested);
    if (!runtime?.available) {
      throw new Error(runtime?.reason || `${requested} is not available`);
    }
  } else if (!runtimeState.runtimes.some(item => item.available)) {
    throw new Error('No supported headless AI runtime is available');
  }
  const documents = await readEffectiveConfigurationDocuments();
  const selectedLabel = requested === 'auto'
    ? '自动选择（Codex 优先）'
    : runtimeState.runtimes.find(item => item.id === requested)?.label || requested;
  const plan = createChangePlan({
    summary: `切换 AI 运行时为 ${selectedLabel}`,
    answer: '已生成运行时切换方案。应用前会备份配置，切换后执行真实运行测试和健康检查。',
    changes: [{
      target: 'config',
      key: 'aiRuntime',
      value: requested,
      reason: `使用本机已探测到的 ${selectedLabel}`,
    }],
  }, documents, {
    id: `plan-${Date.now()}-${randomUUID().slice(0, 8)}`,
  });
  const confirmationCode = plan.confirmationLevel === 'double'
    ? String(randomInt(100000, 1000000))
    : '';
  const pending = pendingConfigurationPlans.add(plan, { confirmationCode });
  await appendConfigurationAudit(config.workdir, {
    event: 'runtime_selection_plan_created',
    planId: plan.id,
    summary: plan.summary,
    runtime: requested,
  });
  return pending;
}

async function setSemanticGroupEngagement(enabled) {
  if (typeof enabled !== 'boolean') throw new Error('Semantic group engagement switch must be boolean');
  const documents = await readEffectiveConfigurationDocuments();
  const plan = createChangePlan({
    summary: enabled
      ? 'Enable semantic group engagement'
      : 'Disable semantic group engagement',
    answer: enabled
      ? 'Unmentioned group messages may be contextually evaluated; explicit mentions keep their fast path.'
      : 'Only the existing explicit-mention group path remains active.',
    changes: [{
      target: 'config',
      key: 'semanticGroupEngagementEnabled',
      value: enabled,
      reason: 'Operator changed the semantic group engagement master switch',
    }],
  }, documents, {
    id: `plan-semantic-group-${Date.now()}-${randomUUID().slice(0, 8)}`,
  });
  if (!plan.changes.length) {
    return { snapshot: null, status: await collectStatus() };
  }
  return applyConfigurationAssistantPlan(plan);
}

async function validateConfigurationOnDisk({ verifyRuntime = false } = {}) {
  const node = join(config.nodeBin, 'node');
  await runBufferedProcess(node, [join(config.workdir, 'scripts', 'check-config.mjs')], {
    cwd: config.workdir,
    timeoutMs: 30_000,
    maxStdoutBytes: 256 * 1024,
    maxStderrBytes: 512 * 1024,
  });
  if (verifyRuntime) {
    await runBufferedProcess(node, [join(config.workdir, 'scripts', 'runtime-smoke.mjs')], {
      cwd: config.workdir,
      env: plannerEnvironment(),
      timeoutMs: 100_000,
      maxStdoutBytes: 256 * 1024,
      maxStderrBytes: 512 * 1024,
    });
  }
}

function synchronizeDashboardConfiguration(rawConfig) {
  Object.assign(
    config,
    effectivePublicConfiguration(INITIAL_PUBLIC_CONFIGURATION, rawConfig),
  );
}

async function waitForMainConfigurationHealth({ verifyChannel = '' } = {}) {
  const deadline = Date.now() + 35_000;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await collectStatus();
    if (mainServiceReadyForChannelChange(latest, verifyChannel)) return latest;
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  const issues = latest?.issueLabels?.join('; ') || 'main process did not become healthy';
  throw new Error(`Post-change health check failed: ${issues}`);
}

async function waitForChannelConnection(channel, { timeoutMs = 35_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let report = channelConnectionReport(channel, await collectStatus());
  while (!report.ok && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1_000));
    report = channelConnectionReport(channel, await collectStatus());
  }
  return report;
}

async function applyConfigurationAssistantPlan(plan, { verifyChannel = '' } = {}) {
  const current = await readEffectiveConfigurationDocuments();
  assertPlanMatchesDocuments(current, plan);
  const snapshot = await createConfigurationSnapshot(config.workdir, {
    summary: `Before: ${plan.summary}`,
    planId: plan.id,
  });
  const updated = applyChangePlan(current, plan);
  const verifyRuntime = plan.changes.some(change => change.target === 'config'
    && ['codexModel', 'aiRuntime'].includes(change.key));
  try {
    await writeConfigurationDocuments(config.workdir, updated);
    await validateConfigurationOnDisk({ verifyRuntime });
    synchronizeDashboardConfiguration(updated.config);
    await restartMainService();
    let status = await waitForMainConfigurationHealth({ verifyChannel });
    if (verifyChannel) {
      const channelReport = await waitForChannelConnection(verifyChannel);
      if (!channelReport.ok) {
        throw new Error(`Channel connection test failed: ${channelReport.detail || 'connection unavailable'}`);
      }
      status = await collectStatus();
    }
    await appendConfigurationAudit(config.workdir, {
      event: 'configuration_applied',
      planId: plan.id,
      snapshotId: snapshot.id,
      summary: plan.summary,
      changes: plan.changes.map(change => ({
        target: change.target,
        key: change.key || '',
        label: change.label,
      })),
    });
    return { snapshot, status };
  } catch (error) {
    let rollbackError = null;
    try {
      const restored = await restoreConfigurationSnapshot(config.workdir, snapshot.id);
      await validateConfigurationOnDisk();
      synchronizeDashboardConfiguration(restored.config);
      await restartMainService();
      await waitForMainConfigurationHealth();
    } catch (failure) {
      rollbackError = failure;
    }
    await appendConfigurationAudit(config.workdir, {
      event: rollbackError ? 'configuration_rollback_failed' : 'configuration_auto_rolled_back',
      planId: plan.id,
      snapshotId: snapshot.id,
      summary: plan.summary,
      error: String(error?.message || error).slice(0, 1000),
      rollbackError: rollbackError ? String(rollbackError?.message || rollbackError).slice(0, 1000) : '',
    });
    const failure = new Error(rollbackError
      ? `Configuration failed and automatic rollback also failed: ${rollbackError.message}`
      : `Configuration failed and was automatically rolled back: ${error.message}`);
    failure.rolledBack = !rollbackError;
    throw failure;
  }
}

async function readChannelConfiguration(documents) {
  const [wecomCredential, wechatCredential] = await Promise.all([
    keychainCredentialExists(channelCredentialTarget('wecom', documents.config)),
    keychainCredentialExists(channelCredentialTarget('wechat', documents.config)),
  ]);
  return channelConfigurationView(documents.config, {
    wecom: wecomCredential,
    wechat: wechatCredential,
  });
}

async function configureChannel(channel, payload) {
  if (payload.confirmed !== true) throw new Error('Channel configuration confirmation is required');
  const normalized = normalizeChannelConfigurationRequest(channel, payload);
  const current = await readEffectiveConfigurationDocuments();
  const proposalChanges = Object.entries(normalized.changes).map(([key, value]) => ({
    target: 'config',
    key,
    value,
    reason: `IM channel configuration: ${channel}`,
  }));
  const plan = createChangePlan({
    summary: `Configure ${channel} IM channel`,
    answer: '',
    changes: proposalChanges,
  }, current, {
    id: `channel-${channel}-${Date.now()}-${randomUUID().slice(0, 8)}`,
  });
  const targetConfiguration = { ...current.config, ...normalized.changes };
  const credentialTarget = channelCredentialTarget(channel, targetConfiguration);
  if (normalized.changes[`${channel === 'wechat' ? 'gewe' : channel}Enabled`] === true
    && credentialTarget && !normalized.credential
    && !await keychainCredentialExists(credentialTarget)) {
    throw new Error(`${credentialTarget.label} is required before this channel can be enabled`);
  }
  let rollbackCredential = null;
  try {
    if (normalized.credential && credentialTarget) {
      rollbackCredential = await replaceKeychainCredential(credentialTarget, normalized.credential);
    }
    const result = await applyConfigurationAssistantPlan(plan, { verifyChannel: channel });
    return {
      ...result,
      report: channelConnectionReport(channel, result.status),
    };
  } catch (error) {
    if (rollbackCredential) {
      try {
        await rollbackCredential();
      } catch (rollbackError) {
        const failure = new Error(`Channel configuration failed; credential rollback also failed: ${rollbackError.message}`);
        failure.rolledBack = false;
        throw failure;
      }
    }
    throw error;
  }
}

async function rollbackConfiguration(snapshotId) {
  const safetySnapshot = await createConfigurationSnapshot(config.workdir, {
    summary: `Before rollback to ${snapshotId}`,
    planId: `rollback-${snapshotId}`,
  });
  try {
    const restored = await restoreConfigurationSnapshot(config.workdir, snapshotId);
    await validateConfigurationOnDisk();
    synchronizeDashboardConfiguration(restored.config);
    await restartMainService();
    const status = await waitForMainConfigurationHealth();
    await appendConfigurationAudit(config.workdir, {
      event: 'configuration_manual_rollback',
      snapshotId,
      safetySnapshotId: safetySnapshot.id,
    });
    return { safetySnapshot, status };
  } catch (error) {
    let recoveryError = null;
    try {
      const recovered = await restoreConfigurationSnapshot(config.workdir, safetySnapshot.id);
      await validateConfigurationOnDisk();
      synchronizeDashboardConfiguration(recovered.config);
      await restartMainService();
      await waitForMainConfigurationHealth();
    } catch (failure) {
      recoveryError = failure;
    }
    await appendConfigurationAudit(config.workdir, {
      event: recoveryError ? 'configuration_rollback_recovery_failed' : 'configuration_rollback_recovered',
      snapshotId,
      safetySnapshotId: safetySnapshot.id,
      error: String(error?.message || error).slice(0, 1000),
      recoveryError: recoveryError ? String(recoveryError?.message || recoveryError).slice(0, 1000) : '',
    });
    throw new Error(recoveryError
      ? `Rollback failed and safety recovery also failed: ${recoveryError.message}`
      : `Rollback failed; the previous configuration was restored: ${error.message}`);
  }
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
    if (request.method === 'POST' && url.pathname === '/api/learning/run') {
      if (!allowedConfigAction(request, 'learning-run')) {
        sendJson(response, 403, { ok: false, error: 'learning action rejected' });
        return;
      }
      if (!config.dailyLearningEnabled) {
        sendJson(response, 409, { ok: false, error: 'daily learning is disabled' });
        return;
      }
      const body = await readDashboardJson(request);
      if (Object.keys(body).length) {
        sendJson(response, 400, { ok: false, error: 'learning request body must be empty' });
        return;
      }
      const requestedAt = requestDailyLearning();
      sendJson(response, 202, { ok: true, queued: true, requestedAt });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/licensing/status') {
      sendJson(response, 200, {
        ...await licensingApi.status(),
        sessionToken: CONFIG_ASSISTANT_SESSION_TOKEN,
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/licensing/contact-card') {
      if (!config.licensingServiceUrl) {
        sendJson(response, 503, { ok: false, error: 'contact card unavailable' });
        return;
      }
      const remote = await licensingFetch(new URL('/v1/contact-card', config.licensingServiceUrl), {
        headers: { accept: 'image/jpeg,image/png,image/webp' },
        signal: AbortSignal.timeout(8_000),
      });
      const contentType = String(remote.headers.get('content-type') || '').split(';')[0];
      const declared = Number(remote.headers.get('content-length') || 0);
      if (!remote.ok
        || !['image/jpeg', 'image/png', 'image/webp'].includes(contentType)
        || declared > 2 * 1024 * 1024) {
        sendJson(response, 502, { ok: false, error: 'contact card unavailable' });
        return;
      }
      const content = Buffer.from(await remote.arrayBuffer());
      if (content.length > 2 * 1024 * 1024) {
        sendJson(response, 502, { ok: false, error: 'contact card unavailable' });
        return;
      }
      response.writeHead(200, {
        ...securityHeaders(contentType),
        'Content-Length': String(content.length),
      });
      response.end(content);
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/licensing/activate') {
      if (!allowedConfigAction(request, 'licensing-activate')) {
        sendJson(response, 403, { ok: false, error: 'licensing action rejected' });
        return;
      }
      try {
        const body = await readDashboardJson(request);
        if (Object.keys(body).some(key => key !== 'code')) {
          throw Object.assign(new Error('Activation request is invalid.'), {
            code: 'invalid_activation_request',
          });
        }
        const result = await licensingApi.activate(body);
        sendJson(response, 200, result);
        restartMainService().catch(error => console.error('[licensing-restart-error]', error));
      } catch (error) {
        sendJson(response, 400, {
          ok: false,
          code: String(error?.code || 'activation_failed'),
          error: 'Invitation code could not be activated.',
        });
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/licensing/invites') {
      if (!allowedConfigAction(request, 'licensing-generate')) {
        sendJson(response, 403, { ok: false, error: 'licensing action rejected' });
        return;
      }
      try {
        const body = await readDashboardJson(request);
        sendJson(response, 201, { ok: true, batch: await licensingApi.generate(body) });
      } catch (error) {
        const unauthorized = error?.code === 'issuer_not_authorized';
        sendJson(response, unauthorized ? 403 : 400, {
          ok: false,
          code: String(error?.code || 'invitation_generation_failed'),
          error: unauthorized
            ? 'Founder issuer is not authorized.'
            : 'Invitation codes could not be generated.',
        });
      }
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/config') {
      const documents = await readEffectiveConfigurationDocuments();
      sendJson(response, 200, {
        ok: true,
        sessionToken: CONFIG_ASSISTANT_SESSION_TOKEN,
        configuration: publicConfiguration(documents.config),
        profile: {
          personaCharacters: documents.persona.length,
          bibleCharacters: documents.bible.length,
          knowledgeDocuments: documents.knowledgeCatalog.length,
        },
        aiRuntime: currentAiRuntimeState(),
        channels: await readChannelConfiguration(documents),
        snapshots: await listConfigurationSnapshots(config.workdir, 12),
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/config/semantic-group-engagement') {
      if (!allowedConfigAction(request, 'semantic-group-engagement')) {
        sendJson(response, 403, { ok: false, error: 'semantic group engagement action rejected' });
        return;
      }
      try {
        const body = await readDashboardJson(request);
        if (body.confirmed !== true) throw new Error('Semantic group engagement confirmation is required');
        const result = await configurationMutationQueue.run(
          'configuration',
          () => setSemanticGroupEngagement(body.enabled),
        );
        sendJson(response, 200, {
          ok: true,
          enabled: body.enabled,
          snapshot: result.snapshot,
          state: result.status.state,
        });
      } catch (error) {
        sendJson(response, error?.rolledBack ? 409 : 400, {
          ok: false,
          rolledBack: Boolean(error?.rolledBack),
          error: String(error?.message || error).slice(0, 700),
        });
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/channels/configure') {
      if (!allowedConfigAction(request, 'channel-config')) {
        sendJson(response, 403, { ok: false, error: 'channel configuration rejected' });
        return;
      }
      try {
        const body = await readDashboardJson(request);
        const channel = String(body.channel || '');
        const result = await configurationMutationQueue.run(
          'configuration',
          () => configureChannel(channel, body),
        );
        sendJson(response, 200, {
          ok: true,
          message: result.report.state === 'disabled'
            ? 'Channel configuration saved; channel remains disabled'
            : 'Channel configured, restarted, and connection-tested',
          snapshot: result.snapshot,
          report: result.report,
        });
      } catch (error) {
        sendJson(response, error?.rolledBack ? 409 : 400, {
          ok: false,
          rolledBack: Boolean(error?.rolledBack),
          error: String(error?.message || error).slice(0, 700),
        });
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/channels/test') {
      if (!allowedConfigAction(request, 'channel-test')) {
        sendJson(response, 403, { ok: false, error: 'channel test rejected' });
        return;
      }
      try {
        const body = await readDashboardJson(request);
        const channel = String(body.channel || '');
        const report = await waitForChannelConnection(channel, { timeoutMs: 8_000 });
        sendJson(response, 200, { ok: true, report });
      } catch (error) {
        sendJson(response, 400, {
          ok: false,
          error: String(error?.message || error).slice(0, 500),
        });
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/config/runtime-plan') {
      if (!allowedConfigAction(request, 'runtime-plan')) {
        sendJson(response, 403, { ok: false, error: 'runtime selection rejected' });
        return;
      }
      try {
        const body = await readDashboardJson(request);
        const plan = await createRuntimeSelectionPlan(body.runtimeId);
        sendJson(response, 200, { ok: true, plan });
      } catch (error) {
        sendJson(response, 400, {
          ok: false,
          error: String(error?.message || error).slice(0, 500),
        });
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/config/plan') {
      if (!allowedConfigAction(request, 'config-plan')) {
        sendJson(response, 403, { ok: false, error: 'configuration action rejected' });
        return;
      }
      try {
        const body = await readDashboardJson(request);
        const plan = await createConfigurationAssistantPlan(body.message);
        sendJson(response, 200, { ok: true, plan });
      } catch (error) {
        await appendConfigurationAudit(config.workdir, {
          event: 'configuration_plan_rejected',
          error: String(error?.message || error).slice(0, 1000),
        }).catch(() => {});
        sendJson(response, 400, {
          ok: false,
          error: String(error?.message || error).slice(0, 500),
        });
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/config/apply') {
      if (!allowedConfigAction(request, 'config-apply')) {
        sendJson(response, 403, { ok: false, error: 'configuration action rejected' });
        return;
      }
      try {
        const body = await readDashboardJson(request);
        const plan = pendingConfigurationPlans.consume(body.planId, {
          confirmationCode: body.confirmationCode,
        });
        if (!plan.changes.length) throw new Error('This plan does not contain any changes');
        const result = await configurationMutationQueue.run(
          'configuration',
          () => applyConfigurationAssistantPlan(plan),
        );
        sendJson(response, 200, {
          ok: true,
          message: 'Configuration applied and verified',
          snapshot: result.snapshot,
          state: result.status.state,
        });
      } catch (error) {
        sendJson(response, error?.rolledBack ? 409 : 400, {
          ok: false,
          rolledBack: Boolean(error?.rolledBack),
          error: String(error?.message || error).slice(0, 700),
        });
      }
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/config/rollback') {
      if (!allowedConfigAction(request, 'config-rollback')) {
        sendJson(response, 403, { ok: false, error: 'configuration action rejected' });
        return;
      }
      try {
        const body = await readDashboardJson(request);
        const snapshotId = String(body.snapshotId || '');
        if (body.confirmation !== `ROLLBACK ${snapshotId}`) {
          throw new Error('Rollback confirmation is invalid');
        }
        const result = await configurationMutationQueue.run(
          'configuration',
          () => rollbackConfiguration(snapshotId),
        );
        sendJson(response, 200, {
          ok: true,
          message: 'Snapshot restored and verified',
          safetySnapshot: result.safetySnapshot,
          state: result.status.state,
        });
      } catch (error) {
        sendJson(response, 400, {
          ok: false,
          error: String(error?.message || error).slice(0, 700),
        });
      }
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
