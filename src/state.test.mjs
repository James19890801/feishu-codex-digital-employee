import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentState } from './state.mjs';

const dir = mkdtempSync(join(tmpdir(), 'xiaozhao-state-'));
try {
  const state = new AgentState(join(dir, 'state.sqlite'));
  state.remember('chat', 'user', 'user', '第一条');
  state.remember('chat', 'user', 'assistant', '第二条');
  assert.deepEqual(state.history('chat', 'user').map(x => x.content), ['第一条', '第二条']);
  state.set('chat', 'paused', true);
  assert.equal(state.get('chat', 'paused'), true);
  state.audit('test', { chatId: 'chat', detail: { ok: true } });

  const now = '2026-07-29T14:00:00.000Z';
  assert.equal(state.enqueueInbound('om_1', 'poll', { hello: 'world' }, now), true);
  assert.equal(state.hasInbound('om_1'), true);
  assert.equal(state.hasInbound('om_missing'), false);
  assert.equal(state.enqueueInbound('om_1', 'websocket', { ignored: true }, now), false);
  assert.equal(state.claimInbound('om_1', now), true);
  assert.equal(state.claimInbound('om_1', now), false);
  state.failInbound('om_1', 'temporary failure', '2026-07-29T14:00:01.000Z');
  assert.equal(state.claimInbound('om_1', '2026-07-29T14:00:00.500Z'), false);
  assert.equal(state.claimInbound('om_1', '2026-07-29T14:00:01.000Z'), true);
  state.completeInbound('om_1', '2026-07-29T14:00:02.000Z');
  assert.equal(state.claimInbound('om_1', '2026-07-29T14:05:00.000Z'), false);

  assert.equal(state.seedInbound('om_old', 'poll', { old: true }, now), true);
  assert.equal(state.claimInbound('om_old', '2026-07-29T14:10:00.000Z'), false);

  state.enqueueInbound('om_crash', 'poll', { crash: true }, now);
  assert.equal(state.claimInbound('om_crash', now), true);
  assert.equal(state.recoverStaleInbound('2026-07-29T14:10:00.000Z', 60_000), 1);
  assert.deepEqual(
    state.listReadyInbound('2026-07-29T14:10:00.000Z', 10).map(item => item.messageId),
    ['om_crash'],
  );
  assert.equal(state.claimInbound('om_crash', '2026-07-29T14:10:00.000Z'), true);
  assert.deepEqual(state.getInbound('om_crash').payload, { crash: true });
  state.deadLetterInbound('om_crash', 'permanent failure', '2026-07-29T14:11:00.000Z');
  assert.equal(state.getInbound('om_crash').status, 'dead');
  assert.equal(state.claimInbound('om_crash', '2026-07-29T14:12:00.000Z'), false);

  state.enqueueInbound('om_recent_crash', 'poll', { crash: true }, now);
  assert.equal(state.claimInbound('om_recent_crash', now), true);
  assert.equal(state.recoverProcessingInbound('2026-07-29T14:00:01.000Z'), 1);
  assert.equal(state.getInbound('om_recent_crash').status, 'pending');

  state.set('pending', 'one', { ok: true });
  state.unset('pending', 'one');
  assert.equal(state.get('pending', 'one', null), null);

  assert.equal(state.consumeRateLimit('sender:1', 1_000, 60_000, 2), true);
  assert.equal(state.consumeRateLimit('sender:1', 2_000, 60_000, 2), true);
  assert.equal(state.consumeRateLimit('sender:1', 3_000, 60_000, 2), false);
  assert.equal(state.consumeRateLimit('sender:1', 61_001, 60_000, 2), true);

  state.db.prepare(`INSERT INTO inbound_message
    (message_id, source, payload, status, attempts, available_at, first_seen_at, updated_at)
    VALUES (?, 'test', ?, 'pending', 0, ?, ?, ?)`)
    .run('om_corrupt', '{not-json', now, now, now);
  const corrupt = state.listReadyInbound(now, 100).find(item => item.messageId === 'om_corrupt');
  assert.equal(corrupt.payload, null);
  assert.equal(corrupt.payloadParseError, true);

  state.seedInbound('om_ancient', 'poll', { old: true }, '2025-01-01T00:00:00.000Z');
  state.db.prepare(`UPDATE inbound_message SET status = 'dead', updated_at = ?
    WHERE message_id = ?`).run('2025-01-01T00:00:00.000Z', 'om_ancient');
  state.audit('ancient', { detail: {}, createdAt: '2025-01-01T00:00:00.000Z' });
  state.db.prepare(`INSERT INTO conversation
    (chat_id, sender_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run('old-chat', 'old-user', 'user', 'old', '2025-01-01T00:00:00.000Z');
  state.set('pending_action', 'expired', { expiresAt: 1, value: { ok: true } });
  const pruned = state.prune({
    now: '2026-07-29T14:00:00.000Z',
    completedInboundRetentionMs: 30 * 86400_000,
    auditRetentionMs: 90 * 86400_000,
    conversationRetentionMs: 90 * 86400_000,
  });
  assert.equal(pruned.inbound >= 1, true);
  assert.equal(pruned.audit >= 1, true);
  assert.equal(pruned.conversation >= 1, true);
  assert.equal(pruned.pendingAction >= 1, true);
  console.log('STATE_TEST_OK');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
