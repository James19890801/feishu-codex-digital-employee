import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentState } from '../src/state.mjs';
import { backfillWeChatRelationshipMemory } from './backfill-wechat-relationship-memory.mjs';

const dir = mkdtempSync(join(tmpdir(), 'aipro-relationship-backfill-'));
try {
  const state = new AgentState(join(dir, 'state.sqlite'));
  state.remember('wechat:user:wxid_alice', 'wechat:wxid_alice', 'user', '我最近在研究流程治理', {
    sourceMessageId: 'wechat:app:101', createdAt: '2026-08-15T01:00:00.000Z',
  });
  state.remember('wechat:user:wxid_alice', 'wechat:wxid_alice', 'assistant', '这个方向可以继续拆。', {
    createdAt: '2026-08-15T01:01:00.000Z',
  });
  state.remember('wechat:group:room@chatroom', 'wechat:wxid_bob', 'user', '群里聊交接标准', {
    sourceMessageId: 'wechat:app:102', createdAt: '2026-08-15T02:00:00.000Z',
  });
  state.remember('wechat:user:wxid_alice', 'wechat:wxid_owner', 'user', '本人代聊内容', {
    sourceMessageId: 'wechat:app:103', createdAt: '2026-08-15T03:00:00.000Z',
  });
  state.remember('oc_feishu', 'ou_someone', 'user', '飞书内容不应进入', {
    sourceMessageId: 'om_1', createdAt: '2026-08-15T04:00:00.000Z',
  });

  const dryRun = backfillWeChatRelationshipMemory({ state, apply: false });
  assert.deepEqual(dryRun, {
    scanned: 4, eligible: 3, inserted: 0, duplicates: 0, skipped: 1,
    people: 2, privateEpisodes: 2, groupEpisodes: 1,
  });
  assert.equal(state.pendingRelationshipPeople().length, 0, 'dry-run cannot write');

  const applied = backfillWeChatRelationshipMemory({ state, apply: true });
  assert.equal(applied.inserted, 3);
  assert.equal(state.pendingRelationshipPeople().length, 2);
  assert.deepEqual(state.relationshipScopes('wechat:wxid_alice'), ['private:wechat:wxid_alice']);
  assert.deepEqual(state.relationshipScopes('wechat:wxid_bob'), ['group:room@chatroom']);
  assert.equal(state.pendingRelationshipEpisodes('wechat:wxid_alice')
    .some(item => item.eventId === 'wechat:app:101'), true);

  const replay = backfillWeChatRelationshipMemory({ state, apply: true });
  assert.equal(replay.inserted, 0);
  assert.equal(replay.duplicates, 3, 'backfill must be idempotent');
  assert.doesNotMatch(JSON.stringify(replay), /流程治理|交接标准|wxid_/);
  state.close();
  console.log('WECHAT_RELATIONSHIP_BACKFILL_TEST_OK');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
