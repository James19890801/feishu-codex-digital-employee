import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { AgentState } from '../src/state.mjs';
import { eligibleOwnerArticle } from '../src/wechat-owner-article-policy.mjs';

function safeSince(value) {
  const parsed = new Date(String(value || ''));
  if (!Number.isFinite(parsed.getTime())) throw new Error('--since must be a valid ISO timestamp');
  return parsed.toISOString();
}

export function replayStoredOwnerArticles({
  state,
  sinceAt,
  limit = 2_000,
  publisherIds,
  ownerWechatIds,
} = {}) {
  if (!state?.db) throw new Error('Replay requires an AgentState instance');
  const since = safeSince(sinceAt);
  const rows = state.db.prepare(`SELECT message_id,payload FROM inbound_message
    WHERE source = 'webhook-gewe-personal-wechat' AND first_seen_at >= ?
    ORDER BY first_seen_at ASC LIMIT ?`).all(
    since,
    Math.max(1, Math.min(10_000, Number(limit) || 2_000)),
  );
  const unique = new Map();
  for (const row of rows) {
    let payload;
    try { payload = JSON.parse(row.payload); } catch { continue; }
    const eligibility = eligibleOwnerArticle({
      senderOpenId: payload?.sender?.sender_id?.open_id,
      linkCandidate: payload?.metadata?.linkCandidate,
      ...(publisherIds ? { publisherIds } : {}),
      ...(ownerWechatIds ? { ownerWechatIds } : {}),
    });
    if (!eligibility.eligible) continue;
    if (!unique.has(eligibility.article.key)) unique.set(eligibility.article.key, payload);
  }
  let enqueued = 0;
  for (const [articleKey, payload] of unique) {
    const messageId = `wechat-owner-article-replay:${articleKey}`;
    const replayPayload = {
      ...payload,
      message: { ...payload.message, message_id: messageId },
      metadata: { ...(payload.metadata || {}), ownerArticleReplay: true },
    };
    if (state.enqueueInbound(messageId, 'owner-article-replay', replayPayload)) enqueued += 1;
  }
  return { scanned: rows.length, discovered: unique.size, enqueued };
}

async function main() {
  const sinceIndex = process.argv.indexOf('--since');
  const sinceAt = sinceIndex >= 0 ? process.argv[sinceIndex + 1] : '';
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { config } = await import('../src/config.mjs');
  const state = new AgentState(join(root, 'data', 'agent-state.sqlite'));
  try {
    const result = replayStoredOwnerArticles({
      state,
      sinceAt,
      publisherIds: config.geweOwnerArticlePublisherIds,
      ownerWechatIds: config.geweOwnerArticleWechatIds,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    state.close();
  }
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${String(error?.message || error)}\n`);
    process.exitCode = 1;
  });
}
