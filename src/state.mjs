import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeMemoryCandidate } from './memory-policy.mjs';

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
        role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversation_lookup
        ON conversation(chat_id, sender_id, id DESC);
      CREATE TABLE IF NOT EXISTS settings (
        scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        updated_at TEXT NOT NULL, PRIMARY KEY(scope, key)
      );
      CREATE TABLE IF NOT EXISTS identity_tombstone (
        term TEXT PRIMARY KEY,
        reason TEXT NOT NULL,
        scope TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_item (
        memory_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        content TEXT NOT NULL,
        source_refs TEXT NOT NULL,
        confidence TEXT NOT NULL,
        valid_from TEXT NOT NULL DEFAULT '',
        valid_until TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_item_active
        ON memory_item(status, kind, updated_at DESC);
      CREATE TABLE IF NOT EXISTS knowledge_source (
        source_id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        locator TEXT NOT NULL,
        owner_id TEXT NOT NULL DEFAULT '',
        reader_ids TEXT NOT NULL DEFAULT '[]',
        sensitivity TEXT NOT NULL DEFAULT 'internal',
        status TEXT NOT NULL DEFAULT 'active',
        freshness_at TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '',
        exclusion_reason TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS knowledge_source_active
        ON knowledge_source(status, type, updated_at DESC);
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
      CREATE TABLE IF NOT EXISTS a1_workitem_cache (
        workitem_id TEXT PRIMARY KEY,
        snapshot TEXT NOT NULL,
        seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS a1_workitem_subscription (
        workitem_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        chat_type TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        PRIMARY KEY(workitem_id, chat_id, sender_id)
      );
      CREATE INDEX IF NOT EXISTS a1_subscription_workitem
        ON a1_workitem_subscription(workitem_id, created_at);
      CREATE TABLE IF NOT EXISTS a1_notification_outbox (
        notification_key TEXT PRIMARY KEY,
        workitem_id TEXT NOT NULL,
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
      CREATE INDEX IF NOT EXISTS a1_notification_due
        ON a1_notification_outbox(status, available_at, created_at);
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
      CREATE TABLE IF NOT EXISTS multica_issue_subscription (
        issue_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        chat_type TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        PRIMARY KEY(issue_id, chat_id, sender_id)
      );
      CREATE TABLE IF NOT EXISTS multica_global_subscription (
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        chat_type TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        PRIMARY KEY(chat_id, sender_id)
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
    `);
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
    const globalSubscriptionColumns = new Set(
      this.db.prepare('PRAGMA table_info(multica_global_subscription)')
        .all()
        .map(row => row.name),
    );
    if (!globalSubscriptionColumns.has('chat_type')) {
      this.db.exec(`ALTER TABLE multica_global_subscription
        ADD COLUMN chat_type TEXT NOT NULL DEFAULT ''`);
    }
  }

  remember(chatId, senderId, role, content) {
    this.db.prepare(`INSERT INTO conversation
      (chat_id, sender_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(chatId, senderId || '', role, String(content).slice(0, 4000), new Date().toISOString());
    this.db.prepare(`DELETE FROM conversation WHERE chat_id = ? AND sender_id = ? AND id NOT IN
      (SELECT id FROM conversation WHERE chat_id = ? AND sender_id = ? ORDER BY id DESC LIMIT 24)`)
      .run(chatId, senderId || '', chatId, senderId || '');
  }

  history(chatId, senderId, limit = 12) {
    return this.db.prepare(`SELECT role, content FROM conversation
      WHERE chat_id = ? AND sender_id = ? ORDER BY id DESC LIMIT ?`)
      .all(chatId, senderId || '', limit).reverse();
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

  registerA1Subscription({
    workitemId, projectId, chatId, senderId = '', chatType = '', snapshot = null,
  }) {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO a1_workitem_subscription
      (workitem_id, project_id, chat_id, sender_id, chat_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(workitem_id, chat_id, sender_id) DO UPDATE SET
        project_id=excluded.project_id, chat_type=excluded.chat_type`)
      .run(String(workitemId), String(projectId), String(chatId), String(senderId), String(chatType), now);
    if (snapshot) this.cacheA1Workitem(snapshot);
  }

  a1WorkitemIds() {
    return this.db.prepare(`SELECT DISTINCT workitem_id
      FROM a1_workitem_subscription ORDER BY workitem_id`).all().map(row => row.workitem_id);
  }

  a1Subscribers(workitemId) {
    return this.db.prepare(`SELECT chat_id, sender_id, chat_type
      FROM a1_workitem_subscription WHERE workitem_id = ? ORDER BY created_at, chat_id`)
      .all(String(workitemId)).map(row => ({
        chatId: row.chat_id,
        senderId: row.sender_id,
        chatType: row.chat_type,
      }));
  }

  getA1WorkitemSnapshot(workitemId) {
    const row = this.db.prepare('SELECT snapshot FROM a1_workitem_cache WHERE workitem_id = ?')
      .get(String(workitemId));
    if (!row) return null;
    try { return JSON.parse(row.snapshot); } catch { return null; }
  }

  cacheA1Workitem(snapshot) {
    const workitemId = String(snapshot?.id || '');
    if (!workitemId) throw new Error('A1 workitem snapshot id is required');
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO a1_workitem_cache(workitem_id, snapshot, seen_at)
      VALUES (?, ?, ?) ON CONFLICT(workitem_id) DO UPDATE SET
        snapshot=excluded.snapshot, seen_at=excluded.seen_at`)
      .run(workitemId, JSON.stringify(snapshot), now);
  }

  enqueueA1Notification({
    notificationKey, workitemId, chatId, senderId = '', chatType = '', content,
    availableAt = new Date().toISOString(),
  }) {
    const now = new Date().toISOString();
    return this.db.prepare(`INSERT OR IGNORE INTO a1_notification_outbox
      (notification_key, workitem_id, chat_id, sender_id, chat_type, content,
       attempts, status, available_at, last_error, created_at, updated_at, dead_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', ?, '', ?, ?, '')`)
      .run(notificationKey, String(workitemId), String(chatId), String(senderId),
        String(chatType), String(content), availableAt, now, now).changes === 1;
  }

  listDueA1Notifications(now = new Date().toISOString(), limit = 200) {
    return this.db.prepare(`SELECT notification_key, workitem_id, chat_id, sender_id,
      chat_type, content, attempts, available_at, last_error
      FROM a1_notification_outbox WHERE status = 'pending' AND available_at <= ?
      ORDER BY available_at, created_at LIMIT ?`)
      .all(now, Math.max(1, Math.min(1000, Number(limit) || 200)))
      .map(row => ({
        notificationKey: row.notification_key,
        workitemId: row.workitem_id,
        chatId: row.chat_id,
        senderId: row.sender_id,
        chatType: row.chat_type,
        content: row.content,
        attempts: Number(row.attempts || 0),
        availableAt: row.available_at,
        lastError: row.last_error,
      }));
  }

  completeA1Notification(notificationKey) {
    return this.db.prepare('DELETE FROM a1_notification_outbox WHERE notification_key = ?')
      .run(String(notificationKey)).changes === 1;
  }

  failA1Notification(notificationKey, error, availableAt, maxAttempts = 10) {
    const row = this.db.prepare(`SELECT attempts, status FROM a1_notification_outbox
      WHERE notification_key = ?`).get(String(notificationKey));
    if (!row || row.status !== 'pending') {
      return { updated: false, deadLettered: row?.status === 'dead', attempts: Number(row?.attempts || 0) };
    }
    const attempts = Number(row.attempts || 0) + 1;
    const deadLettered = attempts >= Math.max(1, Number(maxAttempts) || 10);
    const now = new Date().toISOString();
    const updated = this.db.prepare(`UPDATE a1_notification_outbox SET
      attempts = ?, status = ?, available_at = ?, last_error = ?, updated_at = ?, dead_at = ?
      WHERE notification_key = ? AND status = 'pending'`)
      .run(attempts, deadLettered ? 'dead' : 'pending', String(availableAt),
        String(error || '').slice(0, 1000), now, deadLettered ? now : '',
        String(notificationKey)).changes === 1;
    return { updated, deadLettered: updated && deadLettered, attempts };
  }

  a1NotificationCount(status = 'pending') {
    return Number(this.db.prepare(`SELECT COUNT(*) AS count FROM a1_notification_outbox
      WHERE status = ?`).get(String(status))?.count || 0);
  }

  upsertMemoryItem(candidate) {
    const item = normalizeMemoryCandidate(candidate);
    if (!item.memoryId) throw new Error('memoryId is required');
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO memory_item
      (memory_id, kind, subject, content, source_refs, confidence,
       valid_from, valid_until, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
      ON CONFLICT(memory_id) DO UPDATE SET
        kind=excluded.kind, subject=excluded.subject, content=excluded.content,
        source_refs=excluded.source_refs, confidence=excluded.confidence,
        valid_from=excluded.valid_from, valid_until=excluded.valid_until,
        status='active', updated_at=excluded.updated_at`)
      .run(
        item.memoryId,
        item.kind,
        item.subject,
        item.content,
        JSON.stringify(item.sourceRefs),
        item.confidence,
        item.validFrom,
        item.validUntil,
        now,
      );
    return this.getMemoryItem(item.memoryId);
  }

  getMemoryItem(memoryId) {
    const row = this.db.prepare('SELECT * FROM memory_item WHERE memory_id = ?').get(memoryId);
    if (!row) return null;
    return {
      memoryId: row.memory_id,
      kind: row.kind,
      subject: row.subject,
      content: row.content,
      sourceRefs: JSON.parse(row.source_refs),
      confidence: row.confidence,
      validFrom: row.valid_from,
      validUntil: row.valid_until,
      status: row.status,
      updatedAt: row.updated_at,
    };
  }

  listActiveMemories(query = '', limit = 20) {
    const needle = `%${String(query || '').trim()}%`;
    return this.db.prepare(`SELECT memory_id FROM memory_item
      WHERE status = 'active' AND (subject LIKE ? OR content LIKE ?)
      ORDER BY updated_at DESC LIMIT ?`)
      .all(needle, needle, Math.max(1, Math.min(100, Number(limit) || 20)))
      .map(row => this.getMemoryItem(row.memory_id));
  }

  forgetMemory(memoryId) {
    return this.db.prepare(`UPDATE memory_item SET status = 'forgotten', updated_at = ?
      WHERE memory_id = ? AND status != 'forgotten'`)
      .run(new Date().toISOString(), memoryId).changes === 1;
  }

  upsertKnowledgeSource(source = {}) {
    const sourceId = String(source.sourceId || '').trim();
    const type = String(source.type || '').trim();
    const title = String(source.title || '').trim();
    const locator = String(source.locator || '').trim();
    if (!sourceId || !type || !title || !locator) throw new Error('Knowledge source is incomplete');
    if (/\bALT\b/iu.test(`${title}\n${locator}\n${source.summary || ''}`)) {
      throw new Error('Knowledge source rejected: excluded_scope');
    }
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO knowledge_source
      (source_id, type, title, locator, owner_id, reader_ids, sensitivity,
       status, freshness_at, summary, exclusion_reason, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        type=excluded.type, title=excluded.title, locator=excluded.locator,
        owner_id=excluded.owner_id, reader_ids=excluded.reader_ids,
        sensitivity=excluded.sensitivity, status=excluded.status,
        freshness_at=excluded.freshness_at, summary=excluded.summary,
        exclusion_reason=excluded.exclusion_reason, updated_at=excluded.updated_at`)
      .run(
        sourceId,
        type,
        title,
        locator,
        String(source.ownerId || ''),
        JSON.stringify(Array.isArray(source.readerIds) ? source.readerIds : []),
        String(source.sensitivity || 'internal'),
        String(source.status || 'active'),
        String(source.freshnessAt || ''),
        String(source.summary || ''),
        String(source.exclusionReason || ''),
        now,
      );
    return this.getKnowledgeSource(sourceId);
  }

  getKnowledgeSource(sourceId) {
    const row = this.db.prepare('SELECT * FROM knowledge_source WHERE source_id = ?').get(sourceId);
    if (!row) return null;
    return {
      sourceId: row.source_id,
      type: row.type,
      title: row.title,
      locator: row.locator,
      ownerId: row.owner_id,
      readerIds: JSON.parse(row.reader_ids),
      sensitivity: row.sensitivity,
      status: row.status,
      freshnessAt: row.freshness_at,
      summary: row.summary,
      exclusionReason: row.exclusion_reason,
      updatedAt: row.updated_at,
    };
  }

  audit(event, {
    chatId = '', senderId = '', messageId = '', detail = {},
    createdAt = new Date().toISOString(),
  } = {}) {
    this.db.prepare(`INSERT INTO audit
      (event, chat_id, sender_id, message_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(event, chatId, senderId, messageId, JSON.stringify(detail), createdAt);
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

  subscribeMulticaIssue(issueId, chatId, senderId, options = {}) {
    const legacyCreatedAt = typeof options === 'string' ? options : '';
    const chatType = typeof options === 'object' ? String(options.chatType || '') : '';
    const createdAt = legacyCreatedAt || options.createdAt || new Date().toISOString();
    this.db.prepare(`INSERT INTO multica_issue_subscription
      (issue_id, chat_id, sender_id, chat_type, created_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(issue_id, chat_id, sender_id) DO UPDATE SET
        chat_type=CASE WHEN excluded.chat_type <> '' THEN excluded.chat_type ELSE chat_type END`)
      .run(issueId, chatId, senderId || '', chatType, createdAt);
  }

  unsubscribeMulticaIssue(issueId, chatId, senderId) {
    this.db.prepare(`DELETE FROM multica_issue_subscription
      WHERE issue_id = ? AND chat_id = ? AND sender_id = ?`)
      .run(issueId, chatId, senderId || '');
  }

  multicaIssueSubscribers(issueId) {
    return this.db.prepare(`SELECT chat_id, sender_id, chat_type
      FROM multica_issue_subscription WHERE issue_id = ? ORDER BY created_at, chat_id`)
      .all(issueId)
      .map(row => ({
        chatId: row.chat_id,
        senderId: row.sender_id,
        chatType: row.chat_type,
      }));
  }

  subscribeMulticaGlobal(chatId, senderId, options = {}) {
    const legacyCreatedAt = typeof options === 'string' ? options : '';
    const chatType = typeof options === 'object' ? String(options.chatType || '') : '';
    const createdAt = legacyCreatedAt || options.createdAt || new Date().toISOString();
    this.db.prepare(`INSERT INTO multica_global_subscription
      (chat_id, sender_id, chat_type, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(chat_id, sender_id) DO UPDATE SET
        chat_type=CASE WHEN excluded.chat_type <> '' THEN excluded.chat_type ELSE chat_type END`)
      .run(chatId, senderId || '', chatType, createdAt);
  }

  unsubscribeMulticaGlobal(chatId, senderId) {
    this.db.prepare(`DELETE FROM multica_global_subscription
      WHERE chat_id = ? AND sender_id = ?`).run(chatId, senderId || '');
  }

  multicaGlobalSubscribers() {
    return this.db.prepare(`SELECT chat_id, sender_id, chat_type
      FROM multica_global_subscription ORDER BY created_at, chat_id`)
      .all()
      .map(row => ({
        chatId: row.chat_id,
        senderId: row.sender_id,
        chatType: row.chat_type,
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
