import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { compareSemanticTopics } from './semantic-repeat-guard.mjs';

function parseStoredPayload(value) {
  try {
    return { payload: JSON.parse(value), payloadParseError: false };
  } catch {
    return { payload: null, payloadParseError: true };
  }
}

function outboundContentHash(content) {
  return createHash('sha256').update(String(content || '')).digest('hex');
}

export class AgentState {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS conversation (
        id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, sender_id TEXT NOT NULL,
        role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL,
        source_message_id TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS conversation_lookup
        ON conversation(chat_id, sender_id, id DESC);
      CREATE TABLE IF NOT EXISTS multica_conversation_context (
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        issue_snapshot TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(chat_id, sender_id)
      );
      CREATE TABLE IF NOT EXISTS settings (
        scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        updated_at TEXT NOT NULL, PRIMARY KEY(scope, key)
      );
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY, event TEXT NOT NULL, chat_id TEXT,
        sender_id TEXT, message_id TEXT, detail TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_created ON audit(created_at DESC);
      CREATE TABLE IF NOT EXISTS inbound_message (
        message_id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS inbound_ready
        ON inbound_message(status, available_at, first_seen_at);
      CREATE TABLE IF NOT EXISTS rate_limit (
        subject TEXT PRIMARY KEY,
        window_start_ms INTEGER NOT NULL,
        count INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS semantic_repeat_guard (
        channel TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        topic TEXT NOT NULL,
        reply_count INTEGER NOT NULL DEFAULT 1,
        suppressed_count INTEGER NOT NULL DEFAULT 0,
        first_seen_ms INTEGER NOT NULL,
        last_seen_ms INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL,
        last_action TEXT NOT NULL DEFAULT 'process',
        last_similarity REAL NOT NULL DEFAULT 0,
        last_message_id TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(channel, chat_id, sender_id)
      );
      CREATE INDEX IF NOT EXISTS semantic_repeat_expiry
        ON semantic_repeat_guard(expires_at_ms);
      CREATE TABLE IF NOT EXISTS discussion_session (
        channel TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        session_no INTEGER NOT NULL DEFAULT 1,
        reply_count INTEGER NOT NULL DEFAULT 0,
        low_value_streak INTEGER NOT NULL DEFAULT 0,
        recent_topics TEXT NOT NULL DEFAULT '[]',
        last_checkpoint INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        cooldown_until_ms INTEGER NOT NULL DEFAULT 0,
        last_message_id TEXT NOT NULL DEFAULT '',
        last_action TEXT NOT NULL DEFAULT 'process',
        last_score REAL NOT NULL DEFAULT 0,
        closure_reason TEXT NOT NULL DEFAULT '',
        started_at_ms INTEGER NOT NULL,
        last_seen_ms INTEGER NOT NULL,
        closed_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(channel, chat_id)
      );
      CREATE INDEX IF NOT EXISTS discussion_session_status
        ON discussion_session(status, cooldown_until_ms);
      CREATE TABLE IF NOT EXISTS outbound_echo (
        id INTEGER PRIMARY KEY,
        chat_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        message_id TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS outbound_echo_lookup
        ON outbound_echo(chat_id, content_hash, expires_at);
      CREATE INDEX IF NOT EXISTS outbound_echo_message
        ON outbound_echo(message_id, expires_at);
      CREATE TABLE IF NOT EXISTS multica_issue_cache (
        issue_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        identifier TEXT NOT NULL,
        snapshot TEXT NOT NULL,
        issue_updated_at TEXT NOT NULL,
        seen_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS multica_issue_cache_workspace
        ON multica_issue_cache(workspace_id, issue_updated_at DESC);
      CREATE TABLE IF NOT EXISTS multica_issue_run_cache (
        issue_id TEXT PRIMARY KEY,
        fingerprint TEXT NOT NULL,
        snapshot TEXT NOT NULL,
        seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS multica_issue_subscription (
        issue_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        chat_type TEXT NOT NULL DEFAULT '',
        channel TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        PRIMARY KEY(issue_id, chat_id, sender_id)
      );
      CREATE TABLE IF NOT EXISTS multica_global_subscription (
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        chat_type TEXT NOT NULL DEFAULT '',
        channel TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        PRIMARY KEY(chat_id, sender_id)
      );
      CREATE TABLE IF NOT EXISTS multica_issue_origin (
        issue_id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        chat_type TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS multica_notification_outbox (
        notification_key TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        chat_type TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        available_at TEXT NOT NULL,
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        dead_at TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS multica_notification_due
        ON multica_notification_outbox(available_at, created_at);
      CREATE TABLE IF NOT EXISTS multica_feedback_registration (
        registration_key TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        issue_snapshot TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS multica_feedback_issue
        ON multica_feedback_registration(issue_id);
      CREATE TABLE IF NOT EXISTS multica_dispatch_outbox (
        issue_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        assignee TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        available_at TEXT NOT NULL,
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        dead_at TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS multica_dispatch_due
        ON multica_dispatch_outbox(status, available_at, created_at);
      CREATE TABLE IF NOT EXISTS multica_delivery_contract (
        issue_id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL DEFAULT '',
        chat_type TEXT NOT NULL DEFAULT '',
        formats TEXT NOT NULL,
        request TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'requested',
        artifact_ids TEXT NOT NULL DEFAULT '[]',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        delivered_at TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS multica_delivery_status
        ON multica_delivery_contract(status, updated_at);
      CREATE TABLE IF NOT EXISTS multica_run_message_cursor (
        task_id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        last_seq INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mutation_execution (
        execution_key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        result TEXT NOT NULL DEFAULT '',
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS mutation_execution_status
        ON mutation_execution(status, updated_at);
      CREATE TABLE IF NOT EXISTS learning_run (
        id TEXT PRIMARY KEY,
        learning_date TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL DEFAULT '',
        source_from_at TEXT NOT NULL,
        source_to_at TEXT NOT NULL,
        files_scanned INTEGER NOT NULL DEFAULT 0,
        chats_reviewed INTEGER NOT NULL DEFAULT 0,
        tasks_learned INTEGER NOT NULL DEFAULT 0,
        skills_learned INTEGER NOT NULL DEFAULT 0,
        errors_learned INTEGER NOT NULL DEFAULT 0,
        summary TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS learning_run_date
        ON learning_run(learning_date DESC);
      CREATE TABLE IF NOT EXISTS learning_item (
        id INTEGER PRIMARY KEY,
        run_id TEXT NOT NULL,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        lesson TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS learning_item_run
        ON learning_item(run_id, id);
    `);
    const conversationColumns = new Set(
      this.db.prepare('PRAGMA table_info(conversation)').all().map(row => row.name),
    );
    if (!conversationColumns.has('source_message_id')) {
      this.db.exec(`ALTER TABLE conversation
        ADD COLUMN source_message_id TEXT NOT NULL DEFAULT ''`);
    }
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS conversation_source_once
      ON conversation(chat_id, sender_id, role, source_message_id)
      WHERE source_message_id <> ''`);
    const notificationColumns = new Set(
      this.db.prepare('PRAGMA table_info(multica_notification_outbox)')
        .all()
        .map(row => row.name),
    );
    if (!notificationColumns.has('status')) {
      this.db.exec(`ALTER TABLE multica_notification_outbox
        ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'`);
    }
    if (!notificationColumns.has('dead_at')) {
      this.db.exec(`ALTER TABLE multica_notification_outbox
        ADD COLUMN dead_at TEXT NOT NULL DEFAULT ''`);
    }
    if (!notificationColumns.has('chat_type')) {
      this.db.exec(`ALTER TABLE multica_notification_outbox
        ADD COLUMN chat_type TEXT NOT NULL DEFAULT ''`);
    }
    const issueSubscriptionColumns = new Set(
      this.db.prepare('PRAGMA table_info(multica_issue_subscription)')
        .all()
        .map(row => row.name),
    );
    if (!issueSubscriptionColumns.has('chat_type')) {
      this.db.exec(`ALTER TABLE multica_issue_subscription
        ADD COLUMN chat_type TEXT NOT NULL DEFAULT ''`);
    }
    if (!issueSubscriptionColumns.has('channel')) {
      this.db.exec(`ALTER TABLE multica_issue_subscription
        ADD COLUMN channel TEXT NOT NULL DEFAULT ''`);
    }
    const globalSubscriptionColumns = new Set(
      this.db.prepare('PRAGMA table_info(multica_global_subscription)')
        .all()
        .map(row => row.name),
    );
    if (!globalSubscriptionColumns.has('chat_type')) {
      this.db.exec(`ALTER TABLE multica_global_subscription
        ADD COLUMN chat_type TEXT NOT NULL DEFAULT ''`);
    }
    if (!globalSubscriptionColumns.has('channel')) {
      this.db.exec(`ALTER TABLE multica_global_subscription
        ADD COLUMN channel TEXT NOT NULL DEFAULT ''`);
    }
  }

  remember(chatId, senderId, role, content, { sourceMessageId = '', createdAt = '' } = {}) {
    const normalizedSourceMessageId = String(sourceMessageId || '').slice(0, 500);
    const result = this.db.prepare(`${normalizedSourceMessageId ? 'INSERT OR IGNORE' : 'INSERT'} INTO conversation
      (chat_id, sender_id, role, content, created_at, source_message_id)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      chatId,
      senderId || '',
      role,
      String(content).slice(0, 4000),
      createdAt || new Date().toISOString(),
      normalizedSourceMessageId,
    );
    this.db.prepare(`DELETE FROM conversation WHERE chat_id = ? AND sender_id = ? AND id NOT IN
      (SELECT id FROM conversation WHERE chat_id = ? AND sender_id = ? ORDER BY id DESC LIMIT 120)`)
      .run(chatId, senderId || '', chatId, senderId || '');
    return result.changes > 0;
  }

  history(chatId, senderId, limit = 30) {
    return this.db.prepare(`SELECT role, content, source_message_id AS sourceMessageId
      FROM conversation WHERE chat_id = ? AND sender_id = ? ORDER BY id DESC LIMIT ?`)
      .all(chatId, senderId || '', limit).reverse();
  }

  chatHistory(chatId, limit = 30) {
    return this.db.prepare(`SELECT role, content, sender_id AS senderId,
        source_message_id AS sourceMessageId, created_at AS createdAt
      FROM (
        SELECT id, role, content, sender_id, source_message_id, created_at
        FROM conversation WHERE chat_id = ?
        ORDER BY created_at DESC, id DESC LIMIT ?
      )
      ORDER BY createdAt ASC, id ASC`)
      .all(chatId, limit);
  }

  bindConversationIssue(chatId, senderId, issue) {
    if (!issue?.id || !issue?.identifier) throw new Error('Conversation Issue binding is invalid');
    const snapshot = {
      id: String(issue.id),
      identifier: String(issue.identifier),
      title: String(issue.title || ''),
      description: String(issue.description || '').slice(0, 10_000),
      workspace_id: String(issue.workspace_id || ''),
    };
    this.db.prepare(`INSERT INTO multica_conversation_context
      (chat_id, sender_id, issue_snapshot, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(chat_id, sender_id) DO UPDATE SET
        issue_snapshot=excluded.issue_snapshot, updated_at=excluded.updated_at`)
      .run(chatId, senderId || '', JSON.stringify(snapshot), new Date().toISOString());
  }

  conversationIssue(chatId, senderId) {
    const row = this.db.prepare(`SELECT issue_snapshot FROM multica_conversation_context
      WHERE chat_id = ? AND sender_id = ?`).get(chatId, senderId || '');
    if (row) {
      try { return JSON.parse(row.issue_snapshot); } catch { /* fall back to legacy origin */ }
    }
    const legacy = this.db.prepare(`SELECT cache.snapshot AS issue_snapshot
      FROM multica_issue_origin origin
      JOIN multica_issue_cache cache ON cache.issue_id = origin.issue_id
      WHERE origin.chat_id = ? AND origin.sender_id = ?
      ORDER BY origin.created_at DESC LIMIT 1`).get(chatId, senderId || '');
    if (!legacy) return null;
    try {
      const issue = JSON.parse(legacy.issue_snapshot);
      this.bindConversationIssue(chatId, senderId, issue);
      return this.conversationIssue(chatId, senderId);
    } catch {
      return null;
    }
  }

  set(scope, key, value) {
    this.db.prepare(`INSERT INTO settings(scope, key, value, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(scope, key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
      .run(scope, key, JSON.stringify(value), new Date().toISOString());
  }

  get(scope, key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE scope = ? AND key = ?').get(scope, key);
    if (!row) return fallback;
    try { return JSON.parse(row.value); } catch { return fallback; }
  }

  unset(scope, key) {
    this.db.prepare('DELETE FROM settings WHERE scope = ? AND key = ?').run(scope, key);
  }

  audit(event, {
    chatId = '', senderId = '', messageId = '', detail = {},
    createdAt = new Date().toISOString(),
  } = {}) {
    this.db.prepare(`INSERT INTO audit
      (event, chat_id, sender_id, message_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(event, chatId, senderId, messageId, JSON.stringify(detail), createdAt);
  }

  learningEvidence(fromAt, toAt, { conversationLimit = 1200, auditLimit = 1600 } = {}) {
    const conversations = this.db.prepare(`SELECT role, content, created_at AS createdAt
      FROM conversation WHERE created_at >= ? AND created_at < ?
      ORDER BY created_at ASC LIMIT ?`).all(fromAt, toAt, conversationLimit);
    const audits = this.db.prepare(`SELECT event, detail, created_at AS createdAt
      FROM audit WHERE created_at >= ? AND created_at < ?
      ORDER BY created_at ASC LIMIT ?`).all(fromAt, toAt, auditLimit).map(row => {
      let detail = {};
      try { detail = JSON.parse(row.detail || '{}'); } catch { detail = {}; }
      return { event: row.event, detail, createdAt: row.createdAt };
    });
    return { conversations, audits };
  }

  startLearningRun({ id, learningDate, startedAt, sourceFromAt, sourceToAt }) {
    this.db.prepare(`INSERT INTO learning_run
      (id, learning_date, status, started_at, source_from_at, source_to_at)
      VALUES (?, ?, 'running', ?, ?, ?)
      ON CONFLICT(learning_date) DO UPDATE SET
        id=excluded.id, status='running', started_at=excluded.started_at,
        completed_at='', source_from_at=excluded.source_from_at,
        source_to_at=excluded.source_to_at, error=''`)
      .run(id, learningDate, startedAt, sourceFromAt, sourceToAt);
    this.db.prepare('DELETE FROM learning_item WHERE run_id = ?').run(id);
    this.set('learning', 'status', { state: 'running', runId: id, startedAt });
  }

  completeLearningRun(runId, {
    completedAt = new Date().toISOString(), summary = '', memory = '',
    filesScanned = 0, chatsReviewed = 0, tasksLearned = 0,
    skillsLearned = 0, errorsLearned = 0, items = [],
  } = {}) {
    const result = this.db.prepare(`UPDATE learning_run SET
      status='completed', completed_at=?, files_scanned=?, chats_reviewed=?,
      tasks_learned=?, skills_learned=?, errors_learned=?, summary=?, error=''
      WHERE id=?`).run(
      completedAt, filesScanned, chatsReviewed, tasksLearned,
      skillsLearned, errorsLearned, String(summary).slice(0, 4000), runId,
    );
    if (result.changes !== 1) throw new Error('Daily learning run does not exist');
    this.db.prepare('DELETE FROM learning_item WHERE run_id = ?').run(runId);
    const insert = this.db.prepare(`INSERT INTO learning_item
      (run_id, category, title, lesson, created_at) VALUES (?, ?, ?, ?, ?)`);
    for (const item of items.slice(0, 60)) {
      if (!['task', 'skill', 'error'].includes(item?.category)) continue;
      insert.run(
        runId, item.category, String(item.title || '').slice(0, 200),
        String(item.lesson || '').slice(0, 1000), completedAt,
      );
    }
    this.set('learning', 'memory', String(memory || '').slice(0, 12_000));
    this.set('learning', 'last_completed_date', this.db.prepare(
      'SELECT learning_date FROM learning_run WHERE id = ?',
    ).get(runId)?.learning_date || '');
    this.set('learning', 'status', { state: 'completed', runId, completedAt });
    this.unset('learning', 'manual_requested_at');
  }

  failLearningRun(runId, error, failedAt = new Date().toISOString()) {
    this.db.prepare(`UPDATE learning_run SET status='failed', completed_at=?, error=? WHERE id=?`)
      .run(failedAt, String(error || '').slice(0, 2000), runId);
    this.set('learning', 'status', {
      state: 'failed', runId, failedAt, error: String(error || '').slice(0, 1000),
    });
  }

  learningStatus(limit = 14) {
    const rows = this.db.prepare(`SELECT id, learning_date, status, started_at, completed_at,
      source_from_at, source_to_at, files_scanned, chats_reviewed, tasks_learned,
      skills_learned, errors_learned, summary, error
      FROM learning_run ORDER BY learning_date DESC LIMIT ?`).all(limit);
    const itemQuery = this.db.prepare(`SELECT category, title, lesson
      FROM learning_item WHERE run_id = ? ORDER BY id ASC`);
    const mapRun = row => ({
      id: row.id,
      learningDate: row.learning_date,
      status: row.status,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      sourceFromAt: row.source_from_at,
      sourceToAt: row.source_to_at,
      filesScanned: Number(row.files_scanned),
      chatsReviewed: Number(row.chats_reviewed),
      tasksLearned: Number(row.tasks_learned),
      skillsLearned: Number(row.skills_learned),
      errorsLearned: Number(row.errors_learned),
      summary: row.summary,
      error: row.error,
      items: itemQuery.all(row.id),
    });
    const totals = this.db.prepare(`SELECT COUNT(*) AS total_runs,
      COALESCE(SUM(tasks_learned), 0) AS tasks,
      COALESCE(SUM(skills_learned), 0) AS skills,
      COALESCE(SUM(errors_learned), 0) AS errors
      FROM learning_run WHERE status='completed'`).get();
    const recentRuns = rows.map(mapRun);
    return {
      totalRuns: Number(totals.total_runs || 0),
      totals: {
        tasks: Number(totals.tasks || 0),
        skills: Number(totals.skills || 0),
        errors: Number(totals.errors || 0),
      },
      lastRun: recentRuns[0] || null,
      recentRuns,
      status: this.get('learning', 'status', { state: 'scheduled' }),
      memoryUpdated: Boolean(this.get('learning', 'memory', '')),
    };
  }

  enqueueInbound(messageId, source, payload, now = new Date().toISOString()) {
    const result = this.db.prepare(`INSERT OR IGNORE INTO inbound_message
      (message_id, source, payload, status, attempts, available_at, first_seen_at, updated_at)
      VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)`)
      .run(messageId, source, JSON.stringify(payload), now, now, now);
    return result.changes === 1;
  }

  hasInbound(messageId) {
    return Boolean(this.db.prepare('SELECT 1 FROM inbound_message WHERE message_id = ?').get(messageId));
  }

  seedInbound(messageId, source, payload, now = new Date().toISOString()) {
    const result = this.db.prepare(`INSERT OR IGNORE INTO inbound_message
      (message_id, source, payload, status, attempts, available_at, first_seen_at, updated_at)
      VALUES (?, ?, ?, 'completed', 0, ?, ?, ?)`)
      .run(messageId, source, JSON.stringify(payload), now, now, now);
    return result.changes === 1;
  }

  claimInbound(messageId, now = new Date().toISOString()) {
    const result = this.db.prepare(`UPDATE inbound_message
      SET status = 'processing', attempts = attempts + 1, updated_at = ?, last_error = ''
      WHERE message_id = ? AND status IN ('pending', 'failed') AND available_at <= ?`)
      .run(now, messageId, now);
    return result.changes === 1;
  }

  completeInbound(messageId, now = new Date().toISOString()) {
    this.db.prepare(`UPDATE inbound_message
      SET status = 'completed', updated_at = ?, last_error = '' WHERE message_id = ?`)
      .run(now, messageId);
  }

  failInbound(messageId, error, retryAt, now = new Date().toISOString()) {
    this.db.prepare(`UPDATE inbound_message
      SET status = 'failed', available_at = ?, updated_at = ?, last_error = ?
      WHERE message_id = ?`)
      .run(retryAt, now, String(error || '').slice(0, 2000), messageId);
  }

  deadLetterInbound(messageId, error, now = new Date().toISOString()) {
    this.db.prepare(`UPDATE inbound_message
      SET status = 'dead', updated_at = ?, last_error = ?
      WHERE message_id = ?`)
      .run(now, String(error || '').slice(0, 2000), messageId);
  }

  recoverStaleInbound(now = new Date().toISOString(), staleAfterMs = 5 * 60_000) {
    const staleBefore = new Date(new Date(now).getTime() - staleAfterMs).toISOString();
    const result = this.db.prepare(`UPDATE inbound_message
      SET status = 'pending', available_at = ?, updated_at = ?,
          last_error = CASE WHEN last_error = '' THEN 'recovered stale processing lease' ELSE last_error END
      WHERE status = 'processing' AND updated_at <= ?`)
      .run(now, now, staleBefore);
    return Number(result.changes);
  }

  recoverProcessingInbound(now = new Date().toISOString()) {
    const result = this.db.prepare(`UPDATE inbound_message
      SET status = 'pending', available_at = ?, updated_at = ?,
          last_error = CASE WHEN last_error = '' THEN 'recovered after process restart' ELSE last_error END
      WHERE status = 'processing'`)
      .run(now, now);
    return Number(result.changes);
  }

  listReadyInbound(now = new Date().toISOString(), limit = 20) {
    return this.db.prepare(`SELECT message_id, source, payload, attempts
      FROM inbound_message
      WHERE status IN ('pending', 'failed') AND available_at <= ?
      ORDER BY first_seen_at ASC LIMIT ?`)
      .all(now, limit)
      .map(row => {
        const parsed = parseStoredPayload(row.payload);
        return {
          messageId: row.message_id,
          source: row.source,
          ...parsed,
          attempts: row.attempts,
        };
      });
  }

  getInbound(messageId) {
    const row = this.db.prepare(`SELECT message_id, source, payload, status, attempts,
      available_at, first_seen_at, updated_at, last_error
      FROM inbound_message WHERE message_id = ?`).get(messageId);
    if (!row) return null;
    const parsed = parseStoredPayload(row.payload);
    return {
      messageId: row.message_id,
      source: row.source,
      ...parsed,
      status: row.status,
      attempts: row.attempts,
      availableAt: row.available_at,
      firstSeenAt: row.first_seen_at,
      updatedAt: row.updated_at,
      lastError: row.last_error,
    };
  }

  consumeRateLimit(subject, nowMs, windowMs, limit) {
    const windowStartMs = Math.floor(nowMs / windowMs) * windowMs;
    this.db.prepare(`INSERT INTO rate_limit(subject, window_start_ms, count, updated_at)
      VALUES (?, ?, 0, ?)
      ON CONFLICT(subject) DO UPDATE SET
        window_start_ms = CASE WHEN rate_limit.window_start_ms = excluded.window_start_ms
          THEN rate_limit.window_start_ms ELSE excluded.window_start_ms END,
        count = CASE WHEN rate_limit.window_start_ms = excluded.window_start_ms
          THEN rate_limit.count ELSE 0 END,
        updated_at = excluded.updated_at`)
      .run(subject, windowStartMs, new Date(nowMs).toISOString());
    const result = this.db.prepare(`UPDATE rate_limit
      SET count = count + 1, updated_at = ?
      WHERE subject = ? AND window_start_ms = ? AND count < ?`)
      .run(new Date(nowMs).toISOString(), subject, windowStartMs, limit);
    return result.changes === 1;
  }

  claimSemanticRepeat({
    channel,
    chatId,
    senderId,
    messageId = '',
    topic,
    nowMs = Date.now(),
    windowMs = 30 * 60_000,
    maxReplies = 2,
  } = {}) {
    const normalizedChannel = String(channel || '').trim();
    const normalizedChatId = String(chatId || '').trim();
    const normalizedSenderId = String(senderId || '').trim();
    if (!normalizedChannel || !normalizedChatId || !normalizedSenderId || !topic?.signature) {
      throw new Error('Semantic repeat claim requires channel, chat, sender, and topic');
    }
    const currentMs = Number(nowMs);
    const effectiveWindowMs = Math.max(60_000, Number(windowMs) || 30 * 60_000);
    const effectiveMaxReplies = Math.max(2, Math.min(10, Number(maxReplies) || 2));
    const expiresAtMs = currentMs + effectiveWindowMs;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.db.prepare(`SELECT topic, reply_count, suppressed_count,
          first_seen_ms, expires_at_ms, last_action, last_similarity, last_message_id
        FROM semantic_repeat_guard
        WHERE channel = ? AND chat_id = ? AND sender_id = ?`)
        .get(normalizedChannel, normalizedChatId, normalizedSenderId);
      if (messageId && prior?.last_message_id === String(messageId)) {
        this.db.exec('COMMIT');
        return {
          action: prior.last_action,
          count: Number(prior.reply_count),
          reset: false,
          similarity: Number(prior.last_similarity || 0),
          reason: 'same_inbound_retry',
          expiresAtMs: Number(prior.expires_at_ms),
        };
      }
      let priorTopic = null;
      try { priorTopic = prior ? JSON.parse(prior.topic) : null; } catch { priorTopic = null; }
      const expired = Boolean(prior && Number(prior.expires_at_ms) <= currentMs);
      const comparison = expired || !priorTopic
        ? { repeat: false, similarity: 0, reason: expired ? 'expired' : 'first_seen' }
        : compareSemanticTopics(priorTopic, topic);
      const reset = Boolean(prior && !comparison.repeat);
      let action = 'process';
      let count = 1;
      let suppressedCount = Number(prior?.suppressed_count || 0);
      let firstSeenMs = currentMs;
      if (prior && comparison.repeat) {
        count = Math.min(effectiveMaxReplies + 1, Number(prior.reply_count || 1) + 1);
        firstSeenMs = Number(prior.first_seen_ms || currentMs);
        if (count === effectiveMaxReplies) action = 'close';
        if (count > effectiveMaxReplies) {
          action = 'suppress';
          suppressedCount += 1;
        }
      }
      this.db.prepare(`INSERT INTO semantic_repeat_guard
        (channel, chat_id, sender_id, topic, reply_count, suppressed_count,
         first_seen_ms, last_seen_ms, expires_at_ms, last_action, last_similarity, last_message_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel, chat_id, sender_id) DO UPDATE SET
          topic=excluded.topic,
          reply_count=excluded.reply_count,
          suppressed_count=excluded.suppressed_count,
          first_seen_ms=excluded.first_seen_ms,
          last_seen_ms=excluded.last_seen_ms,
          expires_at_ms=excluded.expires_at_ms,
          last_action=excluded.last_action,
          last_similarity=excluded.last_similarity,
          last_message_id=excluded.last_message_id`)
        .run(
          normalizedChannel,
          normalizedChatId,
          normalizedSenderId,
          JSON.stringify(comparison.repeat && priorTopic ? priorTopic : topic),
          count,
          suppressedCount,
          firstSeenMs,
          currentMs,
          expiresAtMs,
          action,
          Number(comparison.similarity || 0),
          String(messageId || ''),
        );
      this.db.exec('COMMIT');
      return {
        action,
        count,
        reset,
        similarity: Number(comparison.similarity || 0),
        reason: comparison.reason,
        expiresAtMs,
      };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  semanticRepeatStats(nowMs = Date.now()) {
    const activeTopics = Number(this.db.prepare(`SELECT COUNT(*) AS count
      FROM semantic_repeat_guard WHERE expires_at_ms > ?`).get(Number(nowMs))?.count || 0);
    const totalSuppressed = Number(this.db.prepare(`SELECT COALESCE(SUM(suppressed_count), 0) AS count
      FROM semantic_repeat_guard`).get()?.count || 0);
    const latest = this.db.prepare(`SELECT channel, chat_id, sender_id, last_seen_ms,
        reply_count, suppressed_count, last_similarity
      FROM semantic_repeat_guard WHERE last_action = 'suppress'
      ORDER BY last_seen_ms DESC LIMIT 1`).get();
    return {
      activeTopics,
      totalSuppressed,
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

  discussionSession(channel, chatId) {
    const row = this.db.prepare(`SELECT channel, chat_id, session_no, reply_count,
        low_value_streak, recent_topics, last_checkpoint, status, cooldown_until_ms,
        last_message_id, last_action, last_score, closure_reason, started_at_ms,
        last_seen_ms, closed_count
      FROM discussion_session WHERE channel = ? AND chat_id = ?`)
      .get(String(channel || '').trim(), String(chatId || '').trim());
    if (!row) return null;
    let recentTopics = [];
    try { recentTopics = JSON.parse(row.recent_topics); } catch { recentTopics = []; }
    return {
      channel: row.channel,
      chatId: row.chat_id,
      sessionNo: Number(row.session_no),
      replyCount: Number(row.reply_count),
      lowValueStreak: Number(row.low_value_streak),
      recentTopics: Array.isArray(recentTopics) ? recentTopics : [],
      lastCheckpoint: Number(row.last_checkpoint),
      status: row.status,
      cooldownUntilMs: Number(row.cooldown_until_ms),
      lastMessageId: row.last_message_id,
      lastAction: row.last_action,
      lastScore: Number(row.last_score),
      closureReason: row.closure_reason,
      startedAtMs: Number(row.started_at_ms),
      lastSeenMs: Number(row.last_seen_ms),
      closedCount: Number(row.closed_count),
    };
  }

  claimDiscussionTurn({
    channel,
    chatId,
    messageId = '',
    value,
    ownerContinue = false,
    nowMs = Date.now(),
    maxReplies = 100,
    lowValueLimit = 3,
    cooldownMs = 30 * 60_000,
    sessionWindowMs = 30 * 60_000,
  } = {}) {
    const normalizedChannel = String(channel || '').trim();
    const normalizedChatId = String(chatId || '').trim();
    if (!normalizedChannel || !normalizedChatId || !value?.topic) {
      throw new Error('Discussion turn claim requires channel, chat, and value topic');
    }
    const currentMs = Number(nowMs);
    const effectiveMaxReplies = Math.max(2, Math.min(100, Number(maxReplies) || 100));
    const effectiveLowValueLimit = Math.max(1, Math.min(10, Number(lowValueLimit) || 3));
    const effectiveCooldownMs = Math.max(60_000, Number(cooldownMs) || 30 * 60_000);
    const effectiveSessionWindowMs = Math.max(60_000, Number(sessionWindowMs) || 30 * 60_000);
    const normalizedMessageId = String(messageId || '').slice(0, 500);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.discussionSession(normalizedChannel, normalizedChatId);
      if (normalizedMessageId && prior?.lastMessageId === normalizedMessageId) {
        this.db.exec('COMMIT');
        return {
          action: prior.lastAction,
          replyCount: prior.replyCount,
          lowValueStreak: prior.lowValueStreak,
          sessionNo: prior.sessionNo,
          checkpoint: prior.lastCheckpoint,
          cooldownUntilMs: prior.cooldownUntilMs,
          reason: 'same_inbound_retry',
        };
      }
      const stale = Boolean(prior && currentMs - prior.lastSeenMs >= effectiveSessionWindowMs);
      if (prior?.status === 'finalizing' && !stale && !ownerContinue) {
        this.db.exec('COMMIT');
        return {
          action: 'suppress_finalizing',
          replyCount: prior.replyCount,
          lowValueStreak: prior.lowValueStreak,
          sessionNo: prior.sessionNo,
          checkpoint: prior.lastCheckpoint,
          cooldownUntilMs: prior.cooldownUntilMs,
          reason: 'final_reply_pending',
        };
      }
      if (prior?.status === 'cooldown'
        && prior.cooldownUntilMs > currentMs
        && !ownerContinue) {
        this.db.exec('COMMIT');
        return {
          action: 'suppress_cooldown',
          replyCount: prior.replyCount,
          lowValueStreak: prior.lowValueStreak,
          sessionNo: prior.sessionNo,
          checkpoint: prior.lastCheckpoint,
          cooldownUntilMs: prior.cooldownUntilMs,
          reason: prior.closureReason || 'cooldown',
        };
      }

      const restart = Boolean(ownerContinue
        || stale
        || (prior?.status === 'cooldown' && prior.cooldownUntilMs <= currentMs));
      const sessionNo = prior ? prior.sessionNo + (restart ? 1 : 0) : 1;
      const priorReplyCount = restart ? 0 : Number(prior?.replyCount || 0);
      const replyCount = priorReplyCount + 1;
      const lowValueStreak = value.substantive
        ? 0
        : (restart ? 0 : Number(prior?.lowValueStreak || 0)) + 1;
      let action = 'process';
      let status = 'active';
      let cooldownUntilMs = 0;
      let closureReason = '';
      let lastCheckpoint = restart ? 0 : Number(prior?.lastCheckpoint || 0);
      let closedCount = Number(prior?.closedCount || 0);
      if (lowValueStreak >= effectiveLowValueLimit) {
        action = 'close_low_value';
        status = 'cooldown';
        cooldownUntilMs = currentMs + effectiveCooldownMs;
        closureReason = 'low_value_streak';
        closedCount += 1;
      } else if (replyCount >= effectiveMaxReplies) {
        action = 'final';
        status = 'finalizing';
        closureReason = 'hard_limit';
      } else if ([20, 40, 60, 80].includes(replyCount)) {
        action = 'checkpoint';
        lastCheckpoint = replyCount;
      }
      const priorTopics = restart ? [] : (prior?.recentTopics || []);
      const recentTopics = [...priorTopics, value.topic].slice(-6);
      const startedAtMs = restart || !prior ? currentMs : prior.startedAtMs;
      this.db.prepare(`INSERT INTO discussion_session
        (channel, chat_id, session_no, reply_count, low_value_streak, recent_topics,
         last_checkpoint, status, cooldown_until_ms, last_message_id, last_action,
         last_score, closure_reason, started_at_ms, last_seen_ms, closed_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel, chat_id) DO UPDATE SET
          session_no=excluded.session_no,
          reply_count=excluded.reply_count,
          low_value_streak=excluded.low_value_streak,
          recent_topics=excluded.recent_topics,
          last_checkpoint=excluded.last_checkpoint,
          status=excluded.status,
          cooldown_until_ms=excluded.cooldown_until_ms,
          last_message_id=excluded.last_message_id,
          last_action=excluded.last_action,
          last_score=excluded.last_score,
          closure_reason=excluded.closure_reason,
          started_at_ms=excluded.started_at_ms,
          last_seen_ms=excluded.last_seen_ms,
          closed_count=excluded.closed_count`)
        .run(
          normalizedChannel,
          normalizedChatId,
          sessionNo,
          replyCount,
          lowValueStreak,
          JSON.stringify(recentTopics),
          lastCheckpoint,
          status,
          cooldownUntilMs,
          normalizedMessageId,
          action,
          Number(value.score || 0),
          closureReason,
          startedAtMs,
          currentMs,
          closedCount,
        );
      this.db.exec('COMMIT');
      return {
        action,
        replyCount,
        lowValueStreak,
        sessionNo,
        checkpoint: action === 'checkpoint' ? replyCount : 0,
        cooldownUntilMs,
        reason: ownerContinue ? 'owner_continue' : (restart ? 'new_session' : 'active_session'),
      };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  completeDiscussionFinalReply({
    channel,
    chatId,
    nowMs = Date.now(),
    cooldownMs = 30 * 60_000,
  } = {}) {
    const normalizedChannel = String(channel || '').trim();
    const normalizedChatId = String(chatId || '').trim();
    const currentMs = Number(nowMs);
    const effectiveCooldownMs = Math.max(60_000, Number(cooldownMs) || 30 * 60_000);
    const prior = this.discussionSession(normalizedChannel, normalizedChatId);
    if (prior?.status === 'cooldown' && prior.closureReason === 'hard_limit') return true;
    return this.db.prepare(`UPDATE discussion_session
      SET status = 'cooldown', cooldown_until_ms = ?, closure_reason = 'hard_limit',
          last_seen_ms = ?, closed_count = closed_count + 1
      WHERE channel = ? AND chat_id = ? AND status = 'finalizing'`)
      .run(currentMs + effectiveCooldownMs, currentMs, normalizedChannel, normalizedChatId)
      .changes === 1;
  }

  discussionStats(nowMs = Date.now()) {
    const currentMs = Number(nowMs);
    const activeSessions = Number(this.db.prepare(`SELECT COUNT(*) AS count
      FROM discussion_session WHERE status IN ('active', 'finalizing')`).get()?.count || 0);
    const coolingSessions = Number(this.db.prepare(`SELECT COUNT(*) AS count
      FROM discussion_session WHERE status = 'cooldown' AND cooldown_until_ms > ?`)
      .get(currentMs)?.count || 0);
    const closedSessions = Number(this.db.prepare(`SELECT COALESCE(SUM(closed_count), 0) AS count
      FROM discussion_session`).get()?.count || 0);
    const latest = this.db.prepare(`SELECT channel, chat_id, session_no, reply_count,
        closure_reason, last_seen_ms, cooldown_until_ms
      FROM discussion_session WHERE closure_reason <> ''
      ORDER BY last_seen_ms DESC LIMIT 1`).get();
    return {
      activeSessions,
      coolingSessions,
      closedSessions,
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

  markSelfChat(chatId) {
    const normalized = String(chatId || '').trim();
    if (!normalized) return false;
    this.set('self_chat', normalized, true);
    return true;
  }

  isSelfChat(chatId) {
    const normalized = String(chatId || '').trim();
    return normalized ? this.get('self_chat', normalized, false) === true : false;
  }

  claimSelfChatOutbound(chatId, nowMs = Date.now(), {
    windowMs = 60_000,
    limit = 3,
    cooldownMs = 120_000,
  } = {}) {
    const normalized = String(chatId || '').trim();
    if (!normalized) return { allowed: false, tripped: false, openUntilMs: 0 };
    const circuit = this.get('self_chat_circuit', normalized, null);
    const openUntilMs = Number(circuit?.openUntilMs || 0);
    if (openUntilMs > nowMs) {
      return { allowed: false, tripped: false, openUntilMs };
    }
    if (openUntilMs) this.unset('self_chat_circuit', normalized);
    const allowed = this.consumeRateLimit(
      `self-chat-outbound:${normalized}`,
      nowMs,
      Math.max(1_000, Number(windowMs) || 60_000),
      Math.max(1, Number(limit) || 3),
    );
    if (allowed) return { allowed: true, tripped: false, openUntilMs: 0 };
    const nextOpenUntilMs = nowMs + Math.max(10_000, Number(cooldownMs) || 120_000);
    this.set('self_chat_circuit', normalized, {
      openUntilMs: nextOpenUntilMs,
      trippedAt: new Date(nowMs).toISOString(),
    });
    return { allowed: false, tripped: true, openUntilMs: nextOpenUntilMs };
  }

  recordOutboundEcho(chatId, content, {
    messageId = '',
    now = new Date().toISOString(),
    ttlMs = 10 * 60_000,
  } = {}) {
    const expiresAt = new Date(new Date(now).getTime() + Math.max(5_000, Number(ttlMs) || 120_000))
      .toISOString();
    const result = this.db.prepare(`INSERT INTO outbound_echo
      (chat_id, content_hash, message_id, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?)`).run(
      String(chatId || ''),
      outboundContentHash(content),
      String(messageId || ''),
      now,
      expiresAt,
    );
    return Number(result.lastInsertRowid);
  }

  attachOutboundMessageId(id, messageId) {
    if (!messageId) return false;
    return this.db.prepare('UPDATE outbound_echo SET message_id = ? WHERE id = ?')
      .run(String(messageId), Number(id)).changes === 1;
  }

  cancelOutboundEcho(id) {
    return this.db.prepare('DELETE FROM outbound_echo WHERE id = ?')
      .run(Number(id)).changes === 1;
  }

  hasOutboundEcho(chatId, content, {
    messageId = '',
    now = new Date().toISOString(),
  } = {}) {
    this.db.prepare('DELETE FROM outbound_echo WHERE expires_at < ?').run(now);
    const row = messageId
      ? this.db.prepare(`SELECT id FROM outbound_echo
          WHERE message_id = ? AND expires_at >= ? ORDER BY id LIMIT 1`)
        .get(String(messageId), now)
      : null;
    return Boolean(row || this.db.prepare(`SELECT id FROM outbound_echo
      WHERE chat_id = ? AND content_hash = ? AND expires_at >= ?
      ORDER BY id LIMIT 1`).get(String(chatId || ''), outboundContentHash(content), now));
  }

  consumeOutboundEcho(chatId, content, {
    messageId = '',
    now = new Date().toISOString(),
  } = {}) {
    this.db.prepare('DELETE FROM outbound_echo WHERE expires_at < ?').run(now);
    const row = messageId
      ? this.db.prepare(`SELECT id FROM outbound_echo
          WHERE message_id = ? AND expires_at >= ? ORDER BY id LIMIT 1`)
        .get(String(messageId), now)
      : null;
    const matched = row || this.db.prepare(`SELECT id FROM outbound_echo
      WHERE chat_id = ? AND content_hash = ? AND expires_at >= ?
      ORDER BY id LIMIT 1`).get(String(chatId || ''), outboundContentHash(content), now);
    if (!matched) return false;
    return this.db.prepare('DELETE FROM outbound_echo WHERE id = ?')
      .run(matched.id).changes === 1;
  }

  beginMutationExecution(executionKey, kind, now = new Date().toISOString()) {
    const inserted = this.db.prepare(`INSERT OR IGNORE INTO mutation_execution
      (execution_key, kind, status, result, last_error, created_at, updated_at)
      VALUES (?, ?, 'started', '', '', ?, ?)`)
      .run(executionKey, kind, now, now);
    return {
      execute: inserted.changes === 1,
      ...this.getMutationExecution(executionKey),
    };
  }

  completeMutationExecution(executionKey, result, now = new Date().toISOString()) {
    const serialized = JSON.stringify(result ?? null);
    return this.db.prepare(`UPDATE mutation_execution
      SET status = 'succeeded', result = ?, last_error = '', updated_at = ?
      WHERE execution_key = ? AND status = 'started'`)
      .run(serialized, now, executionKey).changes === 1;
  }

  markMutationAmbiguous(executionKey, error, now = new Date().toISOString()) {
    return this.db.prepare(`UPDATE mutation_execution
      SET status = 'ambiguous', last_error = ?, updated_at = ?
      WHERE execution_key = ? AND status != 'succeeded'`)
      .run(String(error || '').slice(0, 2000), now, executionKey).changes === 1;
  }

  failMutationExecutionSafely(executionKey, error, now = new Date().toISOString()) {
    return this.db.prepare(`UPDATE mutation_execution
      SET status = 'failed_safe', last_error = ?, updated_at = ?
      WHERE execution_key = ? AND status = 'started'`)
      .run(String(error || '').slice(0, 2000), now, executionKey).changes === 1;
  }

  getMutationExecution(executionKey) {
    const row = this.db.prepare(`SELECT execution_key, kind, status, result,
      last_error, created_at, updated_at
      FROM mutation_execution WHERE execution_key = ?`).get(executionKey);
    if (!row) return null;
    let result = null;
    try {
      result = row.result ? JSON.parse(row.result) : null;
    } catch {
      result = null;
    }
    return {
      executionKey: row.execution_key,
      kind: row.kind,
      status: row.status,
      result,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  upsertMulticaIssue(issue, seenAt = new Date().toISOString()) {
    if (!issue?.id || !issue?.workspace_id || !issue?.identifier) {
      throw new Error('Multica issue cache requires id, workspace_id, and identifier');
    }
    const normalized = structuredClone(issue);
    const priorRow = this.db.prepare(
      'SELECT snapshot FROM multica_issue_cache WHERE issue_id = ?',
    ).get(issue.id);
    let before = null;
    try {
      before = priorRow ? JSON.parse(priorRow.snapshot) : null;
    } catch {
      before = null;
    }
    const trackedFields = [
      'title',
      'description',
      'status',
      'priority',
      'assignee_id',
      'assignee_type',
      'project_id',
      'parent_issue_id',
      'start_date',
      'due_date',
    ];
    const changedFields = before
      ? trackedFields.filter(key => JSON.stringify(before[key] ?? null)
        !== JSON.stringify(normalized[key] ?? null))
      : [];
    this.db.prepare(`INSERT INTO multica_issue_cache
      (issue_id, workspace_id, identifier, snapshot, issue_updated_at, seen_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(issue_id) DO UPDATE SET
        workspace_id=excluded.workspace_id,
        identifier=excluded.identifier,
        snapshot=excluded.snapshot,
        issue_updated_at=excluded.issue_updated_at,
        seen_at=excluded.seen_at`)
      .run(
        issue.id,
        issue.workspace_id,
        issue.identifier,
        JSON.stringify(normalized),
        String(issue.updated_at || ''),
        seenAt,
      );
    return {
      isNew: !before,
      changedFields,
      before,
      after: normalized,
    };
  }

  getMulticaIssue(issueId) {
    const row = this.db.prepare(
      'SELECT snapshot FROM multica_issue_cache WHERE issue_id = ?',
    ).get(issueId);
    if (!row) return null;
    try { return JSON.parse(row.snapshot); } catch { return null; }
  }

  trackedMulticaIssueIds() {
    return this.db.prepare(`SELECT issue_id FROM (
      SELECT issue_id FROM multica_issue_origin
      UNION
      SELECT issue_id FROM multica_issue_subscription
    ) ORDER BY issue_id`).all().map(row => row.issue_id);
  }

  upsertMulticaIssueRunSummary(issueId, summary, seenAt = new Date().toISOString()) {
    const normalizedIssueId = String(issueId || '').trim();
    const fingerprint = String(summary?.fingerprint || '').trim();
    if (!normalizedIssueId || !fingerprint) {
      throw new Error('Multica run summary requires issue ID and fingerprint');
    }
    const prior = this.db.prepare(`SELECT fingerprint, snapshot
      FROM multica_issue_run_cache WHERE issue_id = ?`).get(normalizedIssueId);
    let before = null;
    try { before = prior ? JSON.parse(prior.snapshot) : null; } catch { before = null; }
    const after = structuredClone(summary);
    this.db.prepare(`INSERT INTO multica_issue_run_cache
      (issue_id, fingerprint, snapshot, seen_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(issue_id) DO UPDATE SET
        fingerprint=excluded.fingerprint,
        snapshot=excluded.snapshot,
        seen_at=excluded.seen_at`)
      .run(normalizedIssueId, fingerprint, JSON.stringify(after), seenAt);
    return {
      isNew: !prior,
      changed: Boolean(prior && prior.fingerprint !== fingerprint),
      before,
      after,
    };
  }

  subscribeMulticaIssue(issueId, chatId, senderId, options = {}) {
    const legacyCreatedAt = typeof options === 'string' ? options : '';
    const chatType = typeof options === 'object' ? String(options.chatType || '') : '';
    const channel = typeof options === 'object' ? String(options.channel || '') : '';
    const createdAt = legacyCreatedAt || options.createdAt || new Date().toISOString();
    this.db.prepare(`INSERT INTO multica_issue_subscription
      (issue_id, chat_id, sender_id, chat_type, channel, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(issue_id, chat_id, sender_id) DO UPDATE SET
        chat_type=CASE WHEN excluded.chat_type <> '' THEN excluded.chat_type ELSE chat_type END,
        channel=CASE WHEN excluded.channel <> '' THEN excluded.channel ELSE channel END`)
      .run(issueId, chatId, senderId || '', chatType, channel, createdAt);
  }

  unsubscribeMulticaIssue(issueId, chatId, senderId) {
    this.db.prepare(`DELETE FROM multica_issue_subscription
      WHERE issue_id = ? AND chat_id = ? AND sender_id = ?`)
      .run(issueId, chatId, senderId || '');
  }

  multicaIssueSubscribers(issueId) {
    return this.db.prepare(`SELECT chat_id, sender_id, chat_type, channel
      FROM multica_issue_subscription WHERE issue_id = ? ORDER BY created_at, chat_id`)
      .all(issueId)
      .map(row => ({
        chatId: row.chat_id,
        senderId: row.sender_id,
        chatType: row.chat_type,
        channel: row.channel,
      }));
  }

  bindMulticaIssueOrigin(issueId, {
    channel,
    chatId,
    senderId = '',
    chatType = '',
    createdAt = new Date().toISOString(),
  } = {}) {
    const normalizedIssueId = String(issueId || '').trim();
    const normalizedChannel = String(channel || '').trim().toLowerCase();
    const normalizedChatId = String(chatId || '').trim();
    if (!normalizedIssueId || !normalizedChannel || !normalizedChatId) {
      throw new Error('Multica Issue origin requires issue, channel, and chat IDs');
    }
    return this.db.prepare(`INSERT OR IGNORE INTO multica_issue_origin
      (issue_id, channel, chat_id, sender_id, chat_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(
        normalizedIssueId,
        normalizedChannel,
        normalizedChatId,
        String(senderId || ''),
        String(chatType || ''),
        createdAt,
      ).changes === 1;
  }

  multicaIssueOrigin(issueId) {
    const row = this.db.prepare(`SELECT issue_id, channel, chat_id, sender_id,
      chat_type, created_at FROM multica_issue_origin WHERE issue_id = ?`)
      .get(String(issueId || ''));
    if (!row) return null;
    return {
      issueId: row.issue_id,
      channel: row.channel,
      chatId: row.chat_id,
      senderId: row.sender_id,
      chatType: row.chat_type,
      createdAt: row.created_at,
    };
  }

  upsertMulticaDeliveryContract({
    issueId,
    workspaceId,
    channel,
    chatId,
    senderId = '',
    chatType = '',
    formats = [],
    request = '',
    createdAt = new Date().toISOString(),
  }) {
    const normalizedFormats = [...new Set((Array.isArray(formats) ? formats : [])
      .map(value => String(value || '').trim().toLowerCase()).filter(Boolean))];
    if (!issueId || !workspaceId || !channel || !chatId || !normalizedFormats.length) {
      throw new Error('Multica delivery contract requires issue, workspace, channel, chat, and formats');
    }
    this.db.prepare(`INSERT INTO multica_delivery_contract
      (issue_id, workspace_id, channel, chat_id, sender_id, chat_type, formats,
       request, status, artifact_ids, attempts, last_error, created_at, updated_at, delivered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'requested', '[]', 0, '', ?, ?, '')
      ON CONFLICT(issue_id) DO UPDATE SET
        workspace_id=excluded.workspace_id,
        channel=excluded.channel,
        chat_id=excluded.chat_id,
        sender_id=excluded.sender_id,
        chat_type=excluded.chat_type,
        formats=excluded.formats,
        request=excluded.request,
        status=CASE
          WHEN multica_delivery_contract.formats <> excluded.formats
            OR multica_delivery_contract.request <> excluded.request
          THEN 'requested' ELSE multica_delivery_contract.status END,
        artifact_ids=CASE
          WHEN multica_delivery_contract.formats <> excluded.formats
            OR multica_delivery_contract.request <> excluded.request
          THEN '[]' ELSE multica_delivery_contract.artifact_ids END,
        attempts=CASE
          WHEN multica_delivery_contract.formats <> excluded.formats
            OR multica_delivery_contract.request <> excluded.request
          THEN 0 ELSE multica_delivery_contract.attempts END,
        last_error='',
        updated_at=excluded.updated_at,
        delivered_at=CASE
          WHEN multica_delivery_contract.formats <> excluded.formats
            OR multica_delivery_contract.request <> excluded.request
          THEN '' ELSE multica_delivery_contract.delivered_at END`)
      .run(
        String(issueId), String(workspaceId), String(channel).toLowerCase(),
        String(chatId), String(senderId), String(chatType),
        JSON.stringify(normalizedFormats), String(request).slice(0, 4000),
        createdAt, createdAt,
      );
    return this.multicaDeliveryContract(issueId);
  }

  multicaDeliveryContract(issueId) {
    const row = this.db.prepare(`SELECT issue_id, workspace_id, channel, chat_id,
      sender_id, chat_type, formats, request, status, artifact_ids, attempts,
      last_error, created_at, updated_at, delivered_at
      FROM multica_delivery_contract WHERE issue_id = ?`).get(String(issueId || ''));
    if (!row) return null;
    let formats = [];
    let artifactIds = [];
    try { formats = JSON.parse(row.formats); } catch { /* invalid rows fail closed */ }
    try { artifactIds = JSON.parse(row.artifact_ids); } catch { /* invalid rows fail closed */ }
    return {
      issueId: row.issue_id,
      workspaceId: row.workspace_id,
      channel: row.channel,
      chatId: row.chat_id,
      senderId: row.sender_id,
      chatType: row.chat_type,
      formats: Array.isArray(formats) ? formats : [],
      request: row.request,
      status: row.status,
      artifactIds: Array.isArray(artifactIds) ? artifactIds : [],
      attempts: Number(row.attempts || 0),
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deliveredAt: row.delivered_at,
    };
  }

  updateMulticaDeliveryContract(issueId, fields = {}, now = new Date().toISOString()) {
    const current = this.multicaDeliveryContract(issueId);
    if (!current) return null;
    const next = {
      status: fields.status === undefined ? current.status : String(fields.status),
      artifactIds: fields.artifactIds === undefined ? current.artifactIds : fields.artifactIds,
      attempts: fields.attempts === undefined ? current.attempts : Number(fields.attempts),
      lastError: fields.lastError === undefined ? current.lastError : String(fields.lastError).slice(0, 2000),
      deliveredAt: fields.deliveredAt === undefined ? current.deliveredAt : String(fields.deliveredAt),
    };
    this.db.prepare(`UPDATE multica_delivery_contract SET
      status = ?, artifact_ids = ?, attempts = ?, last_error = ?,
      updated_at = ?, delivered_at = ? WHERE issue_id = ?`).run(
      next.status,
      JSON.stringify(Array.isArray(next.artifactIds) ? next.artifactIds : []),
      Math.max(0, next.attempts || 0),
      next.lastError,
      now,
      next.deliveredAt,
      String(issueId),
    );
    return this.multicaDeliveryContract(issueId);
  }

  multicaRunMessageCursor(taskId) {
    return Number(this.db.prepare(`SELECT last_seq FROM multica_run_message_cursor
      WHERE task_id = ?`).get(String(taskId || ''))?.last_seq || 0);
  }

  advanceMulticaRunMessageCursor(taskId, issueId, lastSeq, now = new Date().toISOString()) {
    const seq = Math.max(0, Math.floor(Number(lastSeq) || 0));
    this.db.prepare(`INSERT INTO multica_run_message_cursor
      (task_id, issue_id, last_seq, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        issue_id=excluded.issue_id,
        last_seq=MAX(multica_run_message_cursor.last_seq, excluded.last_seq),
        updated_at=excluded.updated_at`).run(
      String(taskId || ''), String(issueId || ''), seq, now,
    );
    return this.multicaRunMessageCursor(taskId);
  }

  subscribeMulticaGlobal(chatId, senderId, options = {}) {
    const legacyCreatedAt = typeof options === 'string' ? options : '';
    const chatType = typeof options === 'object' ? String(options.chatType || '') : '';
    const channel = typeof options === 'object' ? String(options.channel || '') : '';
    const createdAt = legacyCreatedAt || options.createdAt || new Date().toISOString();
    this.db.prepare(`INSERT INTO multica_global_subscription
      (chat_id, sender_id, chat_type, channel, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, sender_id) DO UPDATE SET
        chat_type=CASE WHEN excluded.chat_type <> '' THEN excluded.chat_type ELSE chat_type END,
        channel=CASE WHEN excluded.channel <> '' THEN excluded.channel ELSE channel END`)
      .run(chatId, senderId || '', chatType, channel, createdAt);
  }

  unsubscribeMulticaGlobal(chatId, senderId) {
    this.db.prepare(`DELETE FROM multica_global_subscription
      WHERE chat_id = ? AND sender_id = ?`).run(chatId, senderId || '');
  }

  multicaGlobalSubscribers() {
    return this.db.prepare(`SELECT chat_id, sender_id, chat_type, channel
      FROM multica_global_subscription ORDER BY created_at, chat_id`)
      .all()
      .map(row => ({
        chatId: row.chat_id,
        senderId: row.sender_id,
        chatType: row.chat_type,
        channel: row.channel,
      }));
  }

  bindMulticaFeedbackRegistration({
    registrationKey,
    issue,
    createdAt = new Date().toISOString(),
  }) {
    if (!registrationKey || !issue?.id || !issue?.workspace_id || !issue?.identifier) {
      throw new Error('Multica feedback registration requires a key and complete issue');
    }
    const result = this.db.prepare(`INSERT OR IGNORE INTO multica_feedback_registration
      (registration_key, issue_id, issue_snapshot, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)`).run(
      String(registrationKey),
      String(issue.id),
      JSON.stringify(structuredClone(issue)),
      createdAt,
      createdAt,
    );
    return result.changes === 1;
  }

  getMulticaFeedbackRegistration(registrationKey) {
    const row = this.db.prepare(`SELECT registration_key, issue_snapshot, created_at, updated_at
      FROM multica_feedback_registration WHERE registration_key = ?`)
      .get(String(registrationKey || ''));
    if (!row) return null;
    let issue = null;
    try { issue = JSON.parse(row.issue_snapshot); } catch { return null; }
    return {
      registrationKey: row.registration_key,
      issue,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  enqueueMulticaDispatch({
    issueId,
    workspaceId,
    assignee,
    availableAt = new Date().toISOString(),
  }) {
    const now = new Date().toISOString();
    const result = this.db.prepare(`INSERT OR IGNORE INTO multica_dispatch_outbox
      (issue_id, workspace_id, assignee, attempts, status, available_at,
       last_error, created_at, updated_at, dead_at)
      VALUES (?, ?, ?, 0, 'pending', ?, '', ?, ?, '')`).run(
      String(issueId || ''),
      String(workspaceId || ''),
      String(assignee || ''),
      availableAt,
      now,
      now,
    );
    return result.changes === 1;
  }

  listDueMulticaDispatches(now = new Date().toISOString(), limit = 100) {
    return this.db.prepare(`SELECT issue_id, workspace_id, assignee, attempts,
      available_at, last_error FROM multica_dispatch_outbox
      WHERE status = 'pending' AND available_at <= ?
      ORDER BY available_at, created_at LIMIT ?`)
      .all(now, Math.max(1, Math.min(1000, Number(limit) || 100)))
      .map(row => ({
        issueId: row.issue_id,
        workspaceId: row.workspace_id,
        assignee: row.assignee,
        attempts: Number(row.attempts || 0),
        availableAt: row.available_at,
        lastError: row.last_error,
      }));
  }

  completeMulticaDispatch(issueId) {
    return this.db.prepare(`UPDATE multica_dispatch_outbox
      SET status = 'completed', last_error = '', updated_at = ?, dead_at = ''
      WHERE issue_id = ? AND status = 'pending'`)
      .run(new Date().toISOString(), String(issueId || '')).changes === 1;
  }

  getMulticaDispatch(issueId) {
    const row = this.db.prepare(`SELECT issue_id, workspace_id, assignee, attempts,
      status, available_at, last_error, created_at, updated_at, dead_at
      FROM multica_dispatch_outbox WHERE issue_id = ?`).get(String(issueId || ''));
    if (!row) return null;
    return {
      issueId: row.issue_id,
      workspaceId: row.workspace_id,
      assignee: row.assignee,
      attempts: Number(row.attempts || 0),
      status: row.status,
      availableAt: row.available_at,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deadAt: row.dead_at,
    };
  }

  failMulticaDispatch(issueId, error, availableAt, maxAttempts = 10) {
    const row = this.db.prepare(`SELECT attempts, status FROM multica_dispatch_outbox
      WHERE issue_id = ?`).get(String(issueId || ''));
    if (!row || row.status !== 'pending') {
      return {
        updated: false,
        deadLettered: row?.status === 'dead',
        attempts: Number(row?.attempts || 0),
      };
    }
    const attempts = Number(row.attempts || 0) + 1;
    const deadLettered = attempts >= Math.max(1, Number(maxAttempts) || 10);
    const updatedAt = new Date().toISOString();
    const updated = this.db.prepare(`UPDATE multica_dispatch_outbox
      SET attempts = ?, status = ?, available_at = ?, last_error = ?,
          updated_at = ?, dead_at = ?
      WHERE issue_id = ? AND status = 'pending'`).run(
      attempts,
      deadLettered ? 'dead' : 'pending',
      availableAt,
      String(error || '').slice(0, 1000),
      updatedAt,
      deadLettered ? updatedAt : '',
      String(issueId || ''),
    ).changes === 1;
    return { updated, deadLettered: updated && deadLettered, attempts };
  }

  multicaDispatchPendingCount() {
    return Number(this.db.prepare(`SELECT COUNT(*) AS count FROM multica_dispatch_outbox
      WHERE status = 'pending'`).get()?.count || 0);
  }

  multicaDispatchDeadCount() {
    return Number(this.db.prepare(`SELECT COUNT(*) AS count FROM multica_dispatch_outbox
      WHERE status = 'dead'`).get()?.count || 0);
  }

  enqueueMulticaNotification({
    notificationKey,
    issueId,
    chatId,
    senderId = '',
    chatType = '',
    content,
    availableAt = new Date().toISOString(),
  }) {
    const now = new Date().toISOString();
    const result = this.db.prepare(`INSERT OR IGNORE INTO multica_notification_outbox
      (notification_key, issue_id, chat_id, sender_id, chat_type, content, attempts,
       status, available_at, last_error, created_at, updated_at, dead_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', ?, '', ?, ?, '')`)
      .run(notificationKey, issueId, chatId, senderId, chatType, content, availableAt, now, now);
    return result.changes === 1;
  }

  listDueMulticaNotifications(now = new Date().toISOString(), limit = 200) {
    return this.db.prepare(`SELECT notification_key, issue_id, chat_id, sender_id, chat_type,
      content, attempts, available_at, last_error
      FROM multica_notification_outbox
      WHERE status = 'pending' AND available_at <= ?
      ORDER BY available_at, created_at
      LIMIT ?`)
      .all(now, Math.max(1, Math.min(1000, Number(limit) || 200)))
      .map(row => ({
        notificationKey: row.notification_key,
        issueId: row.issue_id,
        chatId: row.chat_id,
        senderId: row.sender_id,
        chatType: row.chat_type,
        content: row.content,
        attempts: Number(row.attempts || 0),
        availableAt: row.available_at,
        lastError: row.last_error,
      }));
  }

  completeMulticaNotification(notificationKey) {
    return this.db.prepare(
      'DELETE FROM multica_notification_outbox WHERE notification_key = ?',
    ).run(notificationKey).changes === 1;
  }

  deferMulticaNotification(notificationKey, reason, availableAt) {
    const now = new Date().toISOString();
    return this.db.prepare(`UPDATE multica_notification_outbox
      SET available_at = ?, last_error = ?, updated_at = ?
      WHERE notification_key = ? AND status = 'pending'`)
      .run(
        availableAt,
        `deferred: ${String(reason || 'temporarily_unavailable').slice(0, 900)}`,
        now,
        notificationKey,
      ).changes === 1;
  }

  failMulticaNotification(notificationKey, error, availableAt, maxAttempts = 10) {
    const row = this.db.prepare(`SELECT attempts, status
      FROM multica_notification_outbox WHERE notification_key = ?`).get(notificationKey);
    if (!row || row.status !== 'pending') {
      return { updated: false, deadLettered: row?.status === 'dead', attempts: Number(row?.attempts || 0) };
    }
    const attempts = Number(row.attempts || 0) + 1;
    const deadLettered = attempts >= Math.max(1, Number(maxAttempts) || 10);
    const now = new Date().toISOString();
    const updated = this.db.prepare(`UPDATE multica_notification_outbox
      SET attempts = ?, status = ?, available_at = ?, last_error = ?,
          updated_at = ?, dead_at = ?
      WHERE notification_key = ? AND status = 'pending'`)
      .run(
        attempts,
        deadLettered ? 'dead' : 'pending',
        availableAt,
        String(error || '').slice(0, 1000),
        now,
        deadLettered ? now : '',
        notificationKey,
      ).changes === 1;
    return { updated, deadLettered: updated && deadLettered, attempts };
  }

  multicaNotificationCount() {
    return Number(this.db.prepare(
      `SELECT COUNT(*) AS count FROM multica_notification_outbox
       WHERE status = 'pending'`,
    ).get()?.count || 0);
  }

  multicaNotificationDeadCount() {
    return Number(this.db.prepare(
      `SELECT COUNT(*) AS count FROM multica_notification_outbox
       WHERE status = 'dead'`,
    ).get()?.count || 0);
  }

  prune({
    now = new Date().toISOString(),
    completedInboundRetentionMs = 30 * 86400_000,
    auditRetentionMs = 90 * 86400_000,
    conversationRetentionMs = 90 * 86400_000,
  } = {}) {
    const nowMs = new Date(now).getTime();
    const inboundBefore = new Date(nowMs - completedInboundRetentionMs).toISOString();
    const auditBefore = new Date(nowMs - auditRetentionMs).toISOString();
    const conversationBefore = new Date(nowMs - conversationRetentionMs).toISOString();
    const inbound = this.db.prepare(`DELETE FROM inbound_message
      WHERE status IN ('completed', 'dead') AND updated_at < ?`).run(inboundBefore).changes;
    const audit = this.db.prepare('DELETE FROM audit WHERE created_at < ?').run(auditBefore).changes;
    const conversation = this.db.prepare('DELETE FROM conversation WHERE created_at < ?')
      .run(conversationBefore).changes;
    const pendingAction = this.db.prepare(`DELETE FROM settings
      WHERE scope = 'pending_action'
        AND CAST(json_extract(value, '$.expiresAt') AS INTEGER) <= ?`).run(nowMs).changes;
    const rateLimit = this.db.prepare('DELETE FROM rate_limit WHERE updated_at < ?').run(auditBefore).changes;
    const outboundEcho = this.db.prepare('DELETE FROM outbound_echo WHERE expires_at < ?').run(now).changes;
    const semanticRepeat = this.db.prepare(`DELETE FROM semantic_repeat_guard
      WHERE expires_at_ms < ? AND last_seen_ms < ?`)
      .run(nowMs, nowMs - auditRetentionMs).changes;
    const discussion = this.db.prepare(`DELETE FROM discussion_session
      WHERE status = 'cooldown' AND cooldown_until_ms < ? AND last_seen_ms < ?`)
      .run(nowMs, nowMs - auditRetentionMs).changes;
    const multicaNotification = this.db.prepare(`DELETE FROM multica_notification_outbox
      WHERE status = 'dead' AND dead_at < ?`).run(auditBefore).changes;
    const mutation = this.db.prepare(`DELETE FROM mutation_execution
      WHERE status IN ('succeeded', 'failed_safe') AND updated_at < ?`)
      .run(auditBefore).changes;
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
    return {
      inbound: Number(inbound),
      audit: Number(audit),
      conversation: Number(conversation),
      pendingAction: Number(pendingAction),
      rateLimit: Number(rateLimit),
      outboundEcho: Number(outboundEcho),
      semanticRepeat: Number(semanticRepeat),
      discussion: Number(discussion),
      multicaNotification: Number(multicaNotification),
      mutation: Number(mutation),
    };
  }

  inboxStatusCounts() {
    const rows = this.db.prepare(`SELECT status, COUNT(*) AS count
      FROM inbound_message GROUP BY status`).all();
    return Object.fromEntries(rows.map(row => [row.status, Number(row.count)]));
  }

  close() {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.db.close();
  }
}
