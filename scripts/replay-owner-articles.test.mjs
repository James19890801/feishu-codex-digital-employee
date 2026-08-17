import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentState } from '../src/state.mjs';
import { replayStoredOwnerArticles } from './replay-owner-articles.mjs';

const directory = await mkdtemp(join(tmpdir(), 'aipro-owner-article-replay-'));
try {
  const state = new AgentState(join(directory, 'state.sqlite'));
  const payload = {
    message: {
      message_id: 'wechat:device:article-original',
      chat_id: 'wechat:user:gh_07e3d1422f5e',
      chat_type: 'p2p',
      message_type: 'text',
      create_time: '1786925068000',
      content: JSON.stringify({ text: '文章链接' }),
      mentions: [],
    },
    sender: { sender_type: 'user', sender_id: { open_id: 'wechat:gh_07e3d1422f5e' } },
    metadata: {
      channel: 'wechat',
      linkCandidate: {
        url: 'https://mp.weixin.qq.com/s?__biz=Mzkx&mid=2247488166&idx=1&sn=today-article',
        title: '流程管理者做 AI 变革，起点不是技术',
        publisherId: 'gh_07e3d1422f5e',
      },
    },
  };
  state.seedInbound(payload.message.message_id, 'webhook-gewe-personal-wechat', payload, '2026-08-17T00:04:48.000Z');
  state.seedInbound('wechat:device:unrelated', 'webhook-gewe-personal-wechat', {
    ...payload,
    message: { ...payload.message, message_id: 'wechat:device:unrelated' },
    sender: { sender_type: 'user', sender_id: { open_id: 'wechat:someone_else' } },
    metadata: {
      channel: 'wechat',
      linkCandidate: { url: 'https://example.com/article', title: '其他文章' },
    },
  }, '2026-08-17T00:05:00.000Z');

  const first = replayStoredOwnerArticles({
    state,
    sinceAt: '2026-08-17T00:00:00.000Z',
    publisherIds: ['gh_07e3d1422f5e'],
  });
  assert.deepEqual(first, { scanned: 2, discovered: 1, enqueued: 1 });
  const pending = state.db.prepare("SELECT message_id,payload,status FROM inbound_message WHERE source='owner-article-replay'").all();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, 'pending');
  assert.match(pending[0].message_id, /^wechat-owner-article-replay:/);
  const replayPayload = JSON.parse(pending[0].payload);
  assert.equal(replayPayload.metadata.ownerArticleReplay, true);
  assert.equal(replayPayload.message.message_id, pending[0].message_id);

  const second = replayStoredOwnerArticles({
    state,
    sinceAt: '2026-08-17T00:00:00.000Z',
    publisherIds: ['gh_07e3d1422f5e'],
  });
  assert.deepEqual(second, { scanned: 2, discovered: 1, enqueued: 0 });
  state.close();
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log('REPLAY_OWNER_ARTICLES_TEST_OK');
