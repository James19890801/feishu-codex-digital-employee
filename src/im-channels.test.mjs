import assert from 'node:assert/strict';
import {
  buildDingTalkConsumerArgs,
  buildDingTalkSendArgs,
  formatChannelChatId,
  normalizeGeWeWebhook,
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
assert.equal(
  formatChannelChatId('wechat', 'group', 'room-1@chatroom'),
  'wechat:group:room-1@chatroom',
);
assert.deepEqual(parseChannelChatId('wechat:user:wxid_friend'), {
  channel: 'wechat',
  kind: 'user',
  id: 'wxid_friend',
});

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

{
  const payload = normalizeGeWeWebhook({
    TypeName: 'AddMsg',
    Appid: 'device-a',
    Wxid: 'wxid_owner',
    Data: {
      MsgType: 1,
      NewMsgId: 9007199254740993n.toString(),
      FromUserName: { string: 'wxid_friend' },
      ToUserName: { string: 'wxid_owner' },
      Content: { string: '你好，请帮我看下这件事' },
      CreateTime: 1785463200,
      MsgSource: '',
    },
  });
  assert.equal(payload.message.message_id, 'wechat:device-a:9007199254740993');
  assert.equal(payload.message.chat_id, 'wechat:user:wxid_friend');
  assert.equal(payload.message.chat_type, 'p2p');
  assert.equal(payload.sender.sender_id.open_id, 'wechat:wxid_friend');
  assert.equal(JSON.parse(payload.message.content).text, '你好，请帮我看下这件事');
  assert.deepEqual(payload.message.mentions, []);
  assert.equal(payload.metadata.channel, 'wechat');
}

{
  const payload = normalizeGeWeWebhook({
    TypeName: 'AddMsg',
    Appid: 'device-a',
    Wxid: 'wxid_owner',
    Data: {
      MsgType: 1,
      NewMsgId: 'group-message-1',
      FromUserName: { string: 'room-1@chatroom' },
      ToUserName: { string: 'wxid_owner' },
      Content: { string: 'wxid_member:\n@James 帮我总结一下' },
      CreateTime: 1785463200,
      MsgSource: '<msgsource><atuserlist><![CDATA[wxid_owner]]></atuserlist></msgsource>',
    },
  });
  assert.equal(payload.message.chat_id, 'wechat:group:room-1@chatroom');
  assert.equal(payload.message.chat_type, 'group');
  assert.equal(payload.sender.sender_id.open_id, 'wechat:wxid_member');
  assert.equal(JSON.parse(payload.message.content).text, '@James 帮我总结一下');
  assert.equal(payload.message.mentions[0].id, 'wechat-current-user');
}

assert.equal(normalizeGeWeWebhook({
  TypeName: 'AddMsg',
  Appid: 'device-a',
  Wxid: 'wxid_owner',
  Data: {
    MsgType: 1,
    NewMsgId: 'group-message-no-at',
    FromUserName: { string: 'room-1@chatroom' },
    Content: { string: 'wxid_member:\n这是普通群消息' },
    MsgSource: '<msgsource></msgsource>',
  },
}), null);

assert.equal(normalizeGeWeWebhook({
  TypeName: 'AddMsg',
  Appid: 'device-a',
  Wxid: 'wxid_owner',
  Data: {
    MsgType: 1,
    NewMsgId: 'self-message',
    FromUserName: { string: 'wxid_owner' },
    ToUserName: { string: 'wxid_friend' },
    Content: { string: '我自己发的' },
  },
}), null);

{
  const payload = normalizeGeWeWebhook({
    appid: 'device-v2',
    wxid: 'wxid_owner',
    msgType: 'TEXT',
    newMsgId: 'v2-direct-1',
    fromUser: 'wxid_friend',
    toUser: 'wxid_owner',
    content: 'v2 私聊',
    createTime: 1785463200,
    isSelf: false,
  });
  assert.equal(payload.message.message_id, 'wechat:device-v2:v2-direct-1');
  assert.equal(payload.message.chat_id, 'wechat:user:wxid_friend');
}

assert.equal(normalizeGeWeWebhook({
  appid: 'device-v2',
  wxid: 'wxid_owner',
  msgType: 'TEXT',
  newMsgId: 'v2-self',
  fromUser: 'wxid_owner',
  toUser: 'wxid_friend',
  content: 'self',
  isSelf: true,
}), null);

console.log('IM_CHANNELS_TEST_OK');
