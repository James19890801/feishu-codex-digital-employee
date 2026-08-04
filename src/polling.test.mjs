import assert from 'node:assert/strict';
import './human-takeover.test.mjs';
import './conversation-etiquette.test.mjs';
import './delivery-routing.test.mjs';
import {
  buildOwnerControlPollingArgs,
  comparePollingItems,
  buildPollingSearchArgs,
  buildSelfChatPollingArgs,
  markSelfChatMessages,
  normalizeSearchMessage,
  pollFailureDelayMs,
  retryDelayMs,
  selectOwnerControlMessages,
  selectOwnerActivityMessages,
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

const directImage = {
  ...directMessage,
  message_id: 'om_direct_image',
  msg_type: 'image',
  content: '[Image: img_v3_abc123]',
};

const directFile = {
  ...directMessage,
  message_id: 'om_direct_file',
  msg_type: 'file',
  content: '<file key="file_v3_xyz" name="产品说明.pdf"/>',
};

const selfDirectMessage = {
  ...directMessage,
  message_id: 'om_self_chat',
  chat_id: 'oc_self',
  create_time: '2026-07-29 22:36',
  sender: { id: ownerOpenId, sender_type: 'user' },
  self_chat: true,
};

{
  const selected = selectInboundMessages([
    directMessage,
    directImage,
    directFile,
    groupMention,
    { ...groupMention, message_id: 'om_other_at', mentions: [{ id: 'ou_other' }] },
    { ...directMessage, message_id: 'om_self', sender: { id: ownerOpenId, sender_type: 'user' } },
    selfDirectMessage,
    { ...groupMention, message_id: 'om_owner_group', self_chat: true,
      sender: { id: ownerOpenId, sender_type: 'user' } },
    { ...directMessage, message_id: 'om_app', sender: { id: 'cli_app', sender_type: 'app' } },
    { ...directMessage, message_id: 'om_deleted', deleted: true },
    groupMention,
  ], ownerOpenId);

  assert.deepEqual(selected.map(item => item.message_id), [
    'om_group',
    'om_direct',
    'om_direct_file',
    'om_direct_image',
    'om_self_chat',
  ]);
}

{
  const externalFirst = { ...directMessage, message_id: 'om_external_first', create_time: '2026-07-29 22:34' };
  const ownerLater = {
    ...directMessage,
    message_id: 'om_owner_later',
    create_time: '2026-07-29 22:35',
    owner_activity: true,
    sender: { id: ownerOpenId, sender_type: 'user' },
  };
  assert.deepEqual([externalFirst, ownerLater].sort(comparePollingItems).map(item => item.message_id), [
    'om_owner_later',
    'om_external_first',
  ]);
}

{
  const ownerControls = selectOwnerControlMessages([
    { ...groupMention, message_id: 'om_owner_pause', content: '数字人请退场', mentions: [],
      sender: { id: ownerOpenId, sender_type: 'user' } },
    { ...directMessage, message_id: 'om_owner_stop', content: '数字人停止。',
      sender: { id: ownerOpenId, sender_type: 'user' } },
    { ...groupMention, message_id: 'om_attacker_stop', content: '数字人停止', mentions: [],
      sender: { id: 'ou_attacker', sender_type: 'user' } },
    { ...groupMention, message_id: 'om_owner_question', content: '数字人停止后会怎么样', mentions: [],
      sender: { id: ownerOpenId, sender_type: 'user' } },
  ], ownerOpenId);
  assert.deepEqual(ownerControls.map(item => item.message_id), [
    'om_owner_pause',
    'om_owner_stop',
  ]);
  assert.equal(ownerControls.every(item => item.operator_control === true), true);
  assert.equal(normalizeSearchMessage(ownerControls[0]).metadata.operatorControl, true);
}

{
  const ownerActivity = selectOwnerActivityMessages([
    { ...groupMention, message_id: 'om_owner_manual', content: '我来跟他聊', mentions: [],
      sender: { id: ownerOpenId, sender_type: 'user' } },
    { ...directMessage, message_id: 'om_owner_stop_activity', content: '数字人停止',
      sender: { id: ownerOpenId, sender_type: 'user' } },
    { ...directMessage, message_id: 'om_other_activity', sender: { id: 'ou_other', sender_type: 'user' } },
  ], ownerOpenId);
  assert.deepEqual(ownerActivity.map(item => item.message_id), [
    'om_owner_manual',
    'om_owner_stop_activity',
  ]);
  assert.equal(ownerActivity[0].owner_activity, true);
  assert.equal(ownerActivity[0].operator_control, false);
  assert.equal(ownerActivity[1].operator_control, true);
  assert.equal(normalizeSearchMessage(ownerActivity[0]).metadata.ownerActivity, true);
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
  const { message } = normalizeSearchMessage(directImage);
  assert.equal(message.message_type, 'image');
  assert.deepEqual(JSON.parse(message.content), { image_key: 'img_v3_abc123' });
}

{
  const { message } = normalizeSearchMessage(directFile);
  assert.equal(message.message_type, 'file');
  assert.deepEqual(JSON.parse(message.content), {
    file_key: 'file_v3_xyz',
    file_name: '产品说明.pdf',
  });
}

{
  const selfMessages = markSelfChatMessages({
    data: {
      messages: [{
        message_id: 'om_self_1',
        chat_id: 'oc_self',
        msg_type: 'text',
        content: '测试一下',
        create_time: '1785335760000',
        sender: { id: ownerOpenId, sender_type: 'user' },
      }],
    },
  });
  assert.equal(selfMessages.length, 1);
  assert.equal(selfMessages[0].chat_type, 'p2p');
  assert.equal(selfMessages[0].self_chat, true);
  assert.equal(normalizeSearchMessage(selfMessages[0]).metadata.selfChat, true);
  assert.equal(normalizeSearchMessage(selfMessages[0]).metadata.channel, 'feishu');
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

  const selfArgs = buildSelfChatPollingArgs(
    ownerOpenId,
    '2026-07-29T22:30:00+08:00',
    '2026-07-29T22:35:00+08:00',
  );
  assert.deepEqual(selfArgs.slice(0, 6), [
    'im', '+chat-messages-list', '--as', 'user', '--user-id', ownerOpenId,
  ]);
  assert.ok(selfArgs.includes('--no-reactions'));

  const ownerControlArgs = buildOwnerControlPollingArgs(
    ownerOpenId,
    '2026-07-29T22:30:00+08:00',
    '2026-07-29T22:35:00+08:00',
  );
  assert.deepEqual(ownerControlArgs.slice(0, 8), [
    'im', '+messages-search', '--as', 'user', '--query', '', '--sender', ownerOpenId,
  ]);
  assert.equal(ownerControlArgs.includes('--is-at-me'), false);
  assert.equal(ownerControlArgs.includes('--page-all'), true);
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
  const wrappedRateLimit = new Error('process exited with code 1');
  wrappedRateLimit.stderr = JSON.stringify({
    error: { code: 9499, message: 'too many request' },
  });
  assert.equal(
    pollFailureDelayMs(wrappedRateLimit, 1, {
      baseIntervalMs: 5_000,
      random: () => 0,
    }),
    60_000,
  );
}

console.log('POLLING_TEST_OK');
