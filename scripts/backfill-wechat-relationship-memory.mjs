import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AgentState } from '../src/state.mjs';
import {
  canonicalWeChatPersonId,
  WeChatRelationshipMemory,
} from '../src/wechat-relationship-memory.mjs';

function candidate(row) {
  const chatId = String(row.chatId || '');
  const personId = canonicalWeChatPersonId(row.senderId);
  const content = String(row.content || '').trim();
  const role = String(row.role || '');
  const direct = chatId.startsWith('wechat:user:');
  const group = chatId.startsWith('wechat:group:');
  if (!personId || !content || !['user', 'assistant'].includes(role) || (!direct && !group)) {
    return null;
  }
  if (direct) {
    const targetId = chatId.slice('wechat:user:'.length);
    if (personId !== canonicalWeChatPersonId(targetId)) return null;
  }
  return {
    personId,
    chatId,
    chatType: group ? 'group' : 'p2p',
    messageId: String(row.sourceMessageId || '').trim()
      || `wechat-backfill:conversation:${row.id}`,
    text: content,
    direction: role === 'assistant' ? 'outbound' : 'inbound',
    occurredAt: row.createdAt,
  };
}

export function backfillWeChatRelationshipMemory({ state, apply = false } = {}) {
  if (!state?.db) throw new Error('Relationship backfill requires AgentState');
  const rows = state.db.prepare(`SELECT id, chat_id AS chatId, sender_id AS senderId,
    role, content, created_at AS createdAt, source_message_id AS sourceMessageId
    FROM conversation
    WHERE chat_id LIKE 'wechat:user:%' OR chat_id LIKE 'wechat:group:%'
    ORDER BY id ASC LIMIT 100000`).all();
  const memory = new WeChatRelationshipMemory({
    state,
    runAi: async () => '{"facts":[],"profile":{}}',
  });
  const summary = {
    scanned: rows.length,
    eligible: 0,
    inserted: 0,
    duplicates: 0,
    skipped: 0,
    people: 0,
    privateEpisodes: 0,
    groupEpisodes: 0,
  };
  const people = new Set();
  const eventExists = state.db.prepare('SELECT 1 FROM relationship_episode WHERE event_id = ?');
  for (const row of rows) {
    const item = candidate(row);
    if (!item) {
      summary.skipped += 1;
      continue;
    }
    summary.eligible += 1;
    people.add(item.personId);
    if (item.chatType === 'group') summary.groupEpisodes += 1;
    else summary.privateEpisodes += 1;
    if (!apply) {
      if (eventExists.get(item.messageId)) summary.duplicates += 1;
      continue;
    }
    if (memory.observeChat({
      senderId: item.personId,
      chatId: item.chatId,
      chatType: item.chatType,
      messageId: item.messageId,
      text: item.text,
      direction: item.direction,
      occurredAt: item.occurredAt,
    })) summary.inserted += 1;
    else summary.duplicates += 1;
  }
  summary.people = people.size;
  return summary;
}

function commandLine(argv) {
  let apply = false;
  let dbPath = resolve('data', 'agent-state.sqlite');
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') apply = true;
    else if (arg === '--dry-run') apply = false;
    else if (arg === '--db' && argv[index + 1]) dbPath = resolve(argv[++index]);
    else throw new Error(`Unsupported argument: ${String(arg).slice(0, 80)}`);
  }
  const state = new AgentState(dbPath);
  try {
    const summary = backfillWeChatRelationshipMemory({ state, apply });
    process.stdout.write(`${JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...summary })}\n`);
  } finally {
    state.close();
  }
}

if (process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  commandLine(process.argv.slice(2));
}
