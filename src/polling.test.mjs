import assert from 'node:assert/strict';
import {
  buildPollingSearchArgs,
  normalizeSearchMessage,
  pollFailureDelayMs,
  retryDelayMs,
  selectInboundMessages,
  shouldRetryMessage,
  toLarkSearchIso,
} from './polling.mjs';

const ownerOpenId = 'ou_owner';

const groupMention = {
  message_id: 'om_group',
  chat_id: 'oc_group',
  chat_type: 'group',
  msg_type: 'text',
  content: '@James 帮我看一下',
  create_time: '2026-07-29 22:34',
  mentions: [{ id: ownerOpenId, name: 'James' }],
  sender: { id: 'ou_colleague', sender_type: 'user' },
};

const directMessage = {
  message_id: 'om_direct',
  chat_id: 'oc_direct',
  chat_type: 'p2p',
  msg_type: 'text',
  content: '在吗？',
  create_time: '2026-07-29 22:35',
  sender: { id: 'ou_friend', sender_type: 'user' },
};

{
  const selected = selectInboundMessages([
    directMessage,
    groupMention,
    { ...groupMention, message_id: 'om_other_at', mentions: [{ id: 'ou_other' }] },
    { ...directMessage, message_id: 'om_self', sender: { id: ownerOpenId, sender_type: 'user' } },
    { ...directMessage, message_id: 'om_app', sender: { id: 'cli_app', sender_type: 'app' } },
    { ...directMessage, message_id: 'om_deleted', deleted: true },
    groupMention,
  ], ownerOpenId);

  assert.deepEqual(selected.map(item => item.message_id), ['om_group', 'om_direct']);
}

{
  const { message, sender } = normalizeSearchMessage(groupMention);
  assert.equal(message.message_id, 'om_group');
  assert.equal(message.message_type, 'text');
  assert.equal(message.chat_type, 'group');
  assert.equal(JSON.parse(message.content).text, '@James 帮我看一下');
  assert.equal(message.mentions[0].id, ownerOpenId);
  assert.equal(sender.sender_id.open_id, 'ou_colleague');
  assert.equal(sender.sender_type, 'user');
}

{
  assert.equal(
    toLarkSearchIso(new Date('2026-07-29T14:35:06.000Z')),
    '2026-07-29T22:35:06+08:00',
  );
}

{
  const groupArgs = buildPollingSearchArgs(
    'group',
    '2026-07-29T22:30:00+08:00',
    '2026-07-29T22:35:00+08:00',
  );
  assert.equal(groupArgs.includes('--is-at-me'), true);
  assert.deepEqual(groupArgs.slice(0, 5), ['im', '+messages-search', '--as', 'user', '--query']);

  const p2pArgs = buildPollingSearchArgs(
    'p2p',
    '2026-07-29T22:30:00+08:00',
    '2026-07-29T22:35:00+08:00',
  );
  assert.equal(p2pArgs.includes('--is-at-me'), false);
  assert.equal(p2pArgs.includes('--sender-type'), true);
}

{
  assert.equal(retryDelayMs(1), 2_000);
  assert.equal(retryDelayMs(4), 16_000);
  assert.equal(retryDelayMs(20), 60_000);
  assert.equal(shouldRetryMessage(1), true);
  assert.equal(shouldRetryMessage(2), true);
  assert.equal(shouldRetryMessage(3), false);
}

{
  assert.equal(
    pollFailureDelayMs(new Error('too many request'), 1, {
      baseIntervalMs: 5_000,
      random: () => 0,
    }),
    60_000,
  );
  assert.equal(
    pollFailureDelayMs(new Error('HTTP 429 rate limit exceeded'), 3, {
      baseIntervalMs: 5_000,
      random: () => 0.5,
    }),
    65_000,
  );
  assert.equal(
    pollFailureDelayMs(new Error('temporary DNS failure'), 1, {
      baseIntervalMs: 5_000,
      random: () => 0,
    }),
    5_000,
  );
}

console.log('POLLING_TEST_OK');
