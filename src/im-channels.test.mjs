import assert from 'node:assert/strict';
import {
  buildDingTalkConsumerArgs,
  buildDingTalkSendArgs,
  formatChannelChatId,
  normalizeDingTalkEvent,
  normalizeWeComFrame,
  parseChannelChatId,
} from './im-channels.mjs';

assert.equal(
  formatChannelChatId('dingtalk', 'group', 'cidABC'),
  'dingtalk:group:cidABC',
);
assert.deepEqual(parseChannelChatId('dingtalk:user:userABC'), {
  channel: 'dingtalk',
  kind: 'user',
  id: 'userABC',
});
assert.equal(parseChannelChatId('oc_feishu'), null);

assert.deepEqual(buildDingTalkConsumerArgs(), [
  'event', 'consume',
  'user_im_message_receive_at',
  'user_im_message_receive_o2o_all',
  '--flatten',
  '--format', 'ndjson',
]);
assert.deepEqual(buildDingTalkConsumerArgs('corp:user'), [
  '--profile', 'corp:user',
  'event', 'consume',
  'user_im_message_receive_at',
  'user_im_message_receive_o2o_all',
  '--flatten',
  '--format', 'ndjson',
]);

{
  const payload = normalizeDingTalkEvent({
    type: 'user_im_message_receive_at',
    event_id: 'event-1',
    message_id: 'msg-1',
    conversation_id: 'cid-group',
    sender_open_dingtalk_id: 'sender-1',
    content: '@James 请给我项目状态',
    create_time: '2026-07-31T10:00:00+08:00',
  });
  assert.equal(payload.message.message_id, 'dingtalk:msg-1');
  assert.equal(payload.message.chat_id, 'dingtalk:group:cid-group');
  assert.equal(payload.message.chat_type, 'group');
  assert.equal(payload.message.message_type, 'text');
  assert.equal(payload.sender.sender_id.open_id, 'dingtalk:sender-1');
  assert.equal(JSON.parse(payload.message.content).text, '@James 请给我项目状态');
  assert.equal(payload.message.mentions.length, 1);
  assert.equal(payload.metadata.channel, 'dingtalk');
}

{
  const payload = normalizeDingTalkEvent({
    type: 'user_im_message_receive_o2o_all',
    event_id: 'event-2',
    conversation_id: 'cid-direct',
    sender_open_dingtalk_id: 'sender-2',
    content: '你好',
    timestamp: 1785463200000,
  });
  assert.equal(payload.message.message_id, 'dingtalk:event-2');
  assert.equal(payload.message.chat_id, 'dingtalk:user:sender-2');
  assert.equal(payload.message.chat_type, 'p2p');
  assert.deepEqual(payload.message.mentions, []);
}

assert.equal(normalizeDingTalkEvent({
  type: 'user_im_message_receive_group_all',
  event_id: 'ignored',
}), null);

{
  const args = buildDingTalkSendArgs(
    { channel: 'dingtalk', kind: 'group', id: 'cid-group' },
    '收到，我来处理。',
    'reply-uuid',
  );
  assert.deepEqual(args, [
    'chat', 'message', 'send',
    '--group', 'cid-group',
    '--text', '收到，我来处理。',
    '--ai-tag=false',
    '--uuid', 'reply-uuid',
    '--yes',
    '--format', 'json',
  ]);
}

{
  const args = buildDingTalkSendArgs(
    { channel: 'dingtalk', kind: 'user', id: 'sender-2' },
    '你好',
    'direct-uuid',
  );
  assert.deepEqual(args.slice(0, 5), [
    'chat', 'message', 'send', '--open-dingtalk-id', 'sender-2',
  ]);
}

{
  const payload = normalizeWeComFrame({
    headers: { req_id: 'request-1' },
    body: {
      msgid: 'wecom-message-1',
      chattype: 'group',
      chatid: 'group-1',
      from: { userid: 'user-1' },
      msgtype: 'text',
      text: { content: '@AIPRO 帮我总结' },
      create_time: 1785463200,
    },
  });
  assert.equal(payload.message.message_id, 'wecom:wecom-message-1');
  assert.equal(payload.message.chat_id, 'wecom:group:group-1');
  assert.equal(payload.message.chat_type, 'group');
  assert.equal(payload.sender.sender_id.open_id, 'wecom:user-1');
  assert.equal(JSON.parse(payload.message.content).text, '@AIPRO 帮我总结');
  assert.equal(payload.message.mentions.length, 1);
  assert.equal(payload.metadata.channel, 'wecom');
}

{
  const payload = normalizeWeComFrame({
    headers: { req_id: 'request-2' },
    body: {
      chattype: 'single',
      from: { userid: 'user-2' },
      msgtype: 'mixed',
      mixed: {
        msg_item: [
          { msgtype: 'text', text: { content: '第一段' } },
          { msgtype: 'image', image: { url: 'encrypted' } },
          { msgtype: 'text', text: { content: '第二段' } },
        ],
      },
    },
  });
  assert.equal(payload.message.message_id, 'wecom:request-2');
  assert.equal(payload.message.chat_id, 'wecom:user:user-2');
  assert.equal(payload.message.chat_type, 'p2p');
  assert.equal(JSON.parse(payload.message.content).text, '第一段\n第二段');
}

assert.equal(normalizeWeComFrame({
  headers: { req_id: 'request-3' },
  body: { chattype: 'group', from: { userid: 'user-3' }, msgtype: 'event' },
}), null);

console.log('IM_CHANNELS_TEST_OK');
