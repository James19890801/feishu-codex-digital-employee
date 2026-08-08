import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AgentState } from './state.mjs';
import { sendUnlessRecentRepeat } from './outbound-repeat-controller.mjs';
import { semanticTopic } from './semantic-repeat-guard.mjs';

const directory = mkdtempSync(join(tmpdir(), 'aipro-outbound-repeat-'));
const state = new AgentState(join(directory, 'state.sqlite'));

try {
  const sent = [];
  const send = text => async () => {
    sent.push(text);
    return { ok: true };
  };

  const first = await sendUnlessRecentRepeat({
    state,
    chatId: 'group-1',
    audienceKey: 'requester-1',
    text: '后面流程管理相关的我都会先走 IMA 检索，再基于材料回复。',
    nowMs: 1_000,
    send: send('first'),
  });
  assert.equal(first.suppressed, undefined);

  const repeated = await sendUnlessRecentRepeat({
    state,
    chatId: 'group-1',
    audienceKey: 'requester-1',
    text: '后面流程管理相关的我都会先走 ima 检索，再基于材料回复！',
    nowMs: 2_000,
    send: send('repeat'),
  });
  assert.deepEqual(repeated, { suppressed: true, reason: 'outbound_repeat' });
  assert.deepEqual(sent, ['first']);

  await sendUnlessRecentRepeat({
    state,
    chatId: 'screenshot-group',
    audienceKey: 'yang-hong-bao',
    text: '好，后面就按这个边界来：能直答的直接处理，涉及判断、承诺和隐私都交给本人确认。',
    nowMs: 2_100,
    send: send('screenshot-first'),
  });
  const screenshotRepeat = await sendUnlessRecentRepeat({
    state,
    chatId: 'screenshot-group',
    audienceKey: 'yang-hong-bao',
    text: '好，后面按这个边界来：能直接答的直接答，涉及判断、承诺和隐私都交给本人确认。',
    nowMs: 2_200,
    send: send('screenshot-repeat'),
  });
  assert.deepEqual(screenshotRepeat, { suppressed: true, reason: 'outbound_repeat' });
  assert.equal(sent.includes('screenshot-repeat'), false);

  await sendUnlessRecentRepeat({
    state,
    chatId: 'group-1',
    audienceKey: 'requester-2',
    text: '后面流程管理相关的我都会先走 IMA 检索，再基于材料回复。',
    nowMs: 3_000,
    send: send('other-requester'),
  });
  assert.deepEqual(sent, ['first', 'screenshot-first', 'other-requester']);

  await assert.rejects(() => sendUnlessRecentRepeat({
    state,
    chatId: 'direct-1',
    text: '临时发送失败',
    nowMs: 4_000,
    send: async () => { throw new Error('temporary failure'); },
  }), /temporary failure/);
  await sendUnlessRecentRepeat({
    state,
    chatId: 'direct-1',
    text: '临时发送失败',
    nowMs: 5_000,
    send: send('retry-after-failure'),
  });
  assert.deepEqual(sent, [
    'first',
    'screenshot-first',
    'other-requester',
    'retry-after-failure',
  ]);

  await sendUnlessRecentRepeat({
    state,
    chatId: 'progress-group',
    audienceKey: 'requester-1',
    text: '项目当前完成 80%，剩余验收工作明天处理。',
    nowMs: 6_000,
    send: send('progress-80'),
  });
  await sendUnlessRecentRepeat({
    state,
    chatId: 'progress-group',
    audienceKey: 'requester-1',
    text: '项目当前完成 90%，剩余验收工作明天处理。',
    nowMs: 7_000,
    send: send('progress-90'),
  });
  assert.equal(sent.includes('progress-80'), true);
  assert.equal(sent.includes('progress-90'), true);
} finally {
  state.close();
  rmSync(directory, { recursive: true, force: true });
}

const legacyDirectory = mkdtempSync(join(tmpdir(), 'aipro-outbound-repeat-legacy-'));
const legacyPath = join(legacyDirectory, 'state.sqlite');
const legacyDb = new DatabaseSync(legacyPath);
const legacyText = '好，后面就按这个边界来：能直答的直接处理，涉及判断、承诺和隐私都交给本人确认。';
legacyDb.exec(`
  CREATE TABLE conversation (
    id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, sender_id TEXT NOT NULL,
    role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL,
    source_message_id TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE outbound_reply_guard (
    id INTEGER PRIMARY KEY, chat_id TEXT NOT NULL, audience_key TEXT NOT NULL DEFAULT '',
    reply_signature TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    UNIQUE(chat_id, audience_key, reply_signature)
  );
`);
legacyDb.prepare(`INSERT INTO conversation
  (chat_id, sender_id, role, content, created_at, source_message_id)
  VALUES (?, ?, 'assistant', ?, ?, '')`).run(
  'legacy-group',
  'legacy-requester',
  legacyText,
  new Date(9_000).toISOString(),
);
legacyDb.prepare(`INSERT INTO outbound_reply_guard
  (chat_id, audience_key, reply_signature, created_at_ms, expires_at_ms)
  VALUES (?, ?, ?, ?, ?)`).run(
  'legacy-group',
  'legacy-requester',
  semanticTopic(legacyText).signature,
  9_000,
  20_000,
);
legacyDb.close();

const migratedState = new AgentState(legacyPath);
try {
  const migratedClaim = migratedState.claimOutboundReply({
    chatId: 'legacy-group',
    audienceKey: 'legacy-requester',
    content: '好，后面按这个边界来：能直接答的直接答，涉及判断、承诺和隐私都交给本人确认。',
    nowMs: 10_000,
  });
  assert.equal(migratedClaim.allowed, false);
  assert.equal(migratedClaim.reason, 'semantic_similarity');
} finally {
  migratedState.close();
  rmSync(legacyDirectory, { recursive: true, force: true });
}

console.log('OUTBOUND_REPEAT_CONTROLLER_TEST_OK');
