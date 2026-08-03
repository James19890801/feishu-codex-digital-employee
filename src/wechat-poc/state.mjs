import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function parseJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export class WeChatPocState {
  constructor(path) {
    if (!path) throw new Error('WeChat POC state path is required');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS observation (
        fingerprint TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS queue (
        fingerprint TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        generation INTEGER NOT NULL,
        status TEXT NOT NULL,
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS queue_status_created
        ON queue(status, created_at);
      CREATE TABLE IF NOT EXISTS conversation (
        id INTEGER PRIMARY KEY,
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversation_lookup
        ON conversation(chat_id, sender_id, id DESC);
      CREATE TABLE IF NOT EXISTS audit (
        id INTEGER PRIMARY KEY,
        event TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_created ON audit(created_at DESC);
    `);
  }

  recordObservation(fingerprint, event, now = new Date().toISOString()) {
    const result = this.db.prepare(`INSERT OR IGNORE INTO observation
      (fingerprint, payload, observed_at) VALUES (?, ?, ?)`)
      .run(fingerprint, JSON.stringify(event), now);
    return result.changes === 1;
  }

  wasObserved(fingerprint) {
    return Boolean(this.db.prepare('SELECT 1 FROM observation WHERE fingerprint = ?').get(fingerprint));
  }

  enqueue(fingerprint, event, generation, now = new Date().toISOString()) {
    const result = this.db.prepare(`INSERT OR IGNORE INTO queue
      (fingerprint, payload, generation, status, created_at, updated_at)
      VALUES (?, ?, ?, 'pending', ?, ?)`)
      .run(fingerprint, JSON.stringify(event), generation, now, now);
    return result.changes === 1;
  }

  claimNext(now = new Date().toISOString()) {
    const row = this.db.prepare(`SELECT fingerprint, payload, generation
      FROM queue WHERE status = 'pending' ORDER BY created_at, fingerprint LIMIT 1`).get();
    if (!row) return null;
    const claimed = this.db.prepare(`UPDATE queue SET status = 'processing', updated_at = ?
      WHERE fingerprint = ? AND status = 'pending'`).run(now, row.fingerprint);
    if (claimed.changes !== 1) return null;
    const payload = parseJson(row.payload, {});
    return {
      ...payload,
      messageId: payload.messageId || row.fingerprint,
      fingerprint: row.fingerprint,
      generation: Number(row.generation),
    };
  }

  setQueueStatus(fingerprint, status, error = '', now = new Date().toISOString()) {
    if (!['completed', 'cancelled', 'failed', 'uncertain'].includes(status)) {
      throw new Error(`Unsupported WeChat POC queue status: ${status}`);
    }
    this.db.prepare(`UPDATE queue SET status = ?, last_error = ?, updated_at = ?
      WHERE fingerprint = ?`).run(status, String(error || '').slice(0, 1000), now, fingerprint);
  }

  complete(fingerprint) {
    this.setQueueStatus(fingerprint, 'completed');
  }

  cancel(fingerprint, reason = 'cancelled') {
    this.setQueueStatus(fingerprint, 'cancelled', reason);
  }

  fail(fingerprint, error) {
    this.setQueueStatus(fingerprint, 'failed', error);
  }

  markUncertain(fingerprint, error) {
    this.setQueueStatus(fingerprint, 'uncertain', error);
  }

  cancelBeforeGeneration(generation, reason = 'generation_changed', now = new Date().toISOString()) {
    const result = this.db.prepare(`UPDATE queue
      SET status = 'cancelled', last_error = ?, updated_at = ?
      WHERE generation < ? AND status IN ('pending', 'processing')`)
      .run(String(reason).slice(0, 1000), now, generation);
    return Number(result.changes);
  }

  statusCounts() {
    return Object.fromEntries(this.db.prepare(`SELECT status, COUNT(*) count
      FROM queue GROUP BY status`).all().map(row => [row.status, Number(row.count)]));
  }

  remember(chatId, senderId, role, content, now = new Date().toISOString()) {
    this.db.prepare(`INSERT INTO conversation
      (chat_id, sender_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(chatId, senderId || '', role, String(content).slice(0, 4000), now);
    this.db.prepare(`DELETE FROM conversation WHERE chat_id = ? AND sender_id = ? AND id NOT IN
      (SELECT id FROM conversation WHERE chat_id = ? AND sender_id = ? ORDER BY id DESC LIMIT 24)`)
      .run(chatId, senderId || '', chatId, senderId || '');
  }

  history(chatId, senderId, limit = 12) {
    return this.db.prepare(`SELECT role, content FROM conversation
      WHERE chat_id = ? AND sender_id = ? ORDER BY id DESC LIMIT ?`)
      .all(chatId, senderId || '', limit)
      .reverse()
      .map(row => ({ role: row.role, content: row.content }));
  }

  audit(event, {
    chatId = '',
    messageId = '',
    detail = {},
    now = new Date().toISOString(),
  } = {}) {
    this.db.prepare(`INSERT INTO audit
      (event, chat_id, message_id, detail, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(event, chatId, messageId, JSON.stringify(detail), now);
  }

  recentAudit(limit = 20) {
    return this.db.prepare(`SELECT event, chat_id, message_id, detail, created_at
      FROM audit ORDER BY id DESC LIMIT ?`).all(limit).map(row => ({
      event: row.event,
      chatId: row.chat_id,
      messageId: row.message_id,
      detail: parseJson(row.detail, {}),
      createdAt: row.created_at,
    }));
  }

  close() {
    this.db.close();
  }
}
