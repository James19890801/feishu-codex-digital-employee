import assert from 'node:assert/strict';
import * as imChannelHelpers from './im-channels.mjs';
import {
  buildDingTalkConversationPollingArgs,
  buildDingTalkSelfPollingArgs,
  buildDingTalkConsumerArgs,
  buildDingTalkSendArgs,
  formatChannelChatId,
  normalizeGeWeWebhook,
  normalizeDingTalkEvent,
  normalizeDingTalkSelfMessages,
  normalizeWeComFrame,
  parseChannelChatId,
  prepareGroupMention,
} from './im-channels.mjs';

assert.equal(
  typeof imChannelHelpers.buildDingTalkProcessEnv,
  'function',
  'DingTalk process environment must be built by a tested helper',
);
if (typeof imChannelHelpers.buildDingTalkProcessEnv === 'function') {
  assert.deepEqual(imChannelHelpers.buildDingTalkProcessEnv({
    dingtalkBin: '/opt/dws/bin/dws',
    nodeBin: '/opt/node/bin',
    pathEnv: '/usr/bin:/bin',
    baseEnv: { LANG: 'zh_CN.UTF-8' },
  }), {
    LANG: 'zh_CN.UTF-8',
    PATH: '/opt/dws/bin:/opt/node/bin:/usr/bin:/bin',
  });
}

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

assert.deepEqual(prepareGroupMention({
  chatId: 'oc_feishu_group',
  chatType: 'group',
  senderId: 'ou_requester',
  text: 'MYS-4 状态已更新',
}), {
  text: '<at user_id="ou_requester">发起人</at>\nMYS-4 状态已更新',
  atOpenDingTalkIds: [],
});
assert.deepEqual(prepareGroupMention({
  chatId: 'dingtalk:group:cidABC',
  chatType: 'group',
  senderId: 'dingtalk:open-requester',
  text: 'MYS-4 状态已更新',
}), {
  text: '<@open-requester>\nMYS-4 状态已更新',
  atOpenDingTalkIds: ['open-requester'],
});
assert.deepEqual(prepareGroupMention({
  chatId: 'oc_feishu_direct',
  chatType: 'p2p',
  senderId: 'ou_requester',
  text: 'MYS-4 状态已更新',
}), {
  text: 'MYS-4 状态已更新',
  atOpenDingTalkIds: [],
});
assert.equal(
  formatChannelChatId('wechat', 'group', 'room-1@chatroom'),
  'wechat:group:room-1@chatroom',
);
assert.deepEqual(parseChannelChatId('wechat:user:wxid_friend'), {
  channel: 'wechat',
  kind: 'user',
  id: 'wxid_friend',
});

{
  const ownerControl = normalizeGeWeWebhook({
    appid: 'app-1',
    wxid: 'wxid_owner',
    msgType: 'TEXT',
    isSelf: true,
    fromUser: 'wxid_owner',
    toUser: 'wxid_friend',
    content: '数字人请退场',
    newMsgId: 'self-control-1',
    createTime: 1785571200,
  });
  assert.equal(ownerControl.message.chat_id, 'wechat:user:wxid_friend');
  assert.equal(ownerControl.sender.sender_id.open_id, 'wechat:wxid_owner');
  assert.equal(ownerControl.metadata.ownerControlAuthenticated, true);
  assert.equal(normalizeGeWeWebhook({
    appid: 'app-1', wxid: 'wxid_owner', msgType: 'TEXT', isSelf: true,
    fromUser: 'wxid_owner', toUser: 'wxid_friend', content: '普通人工消息',
    newMsgId: 'self-normal-1',
  }), null);
}

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

assert.deepEqual(buildDingTalkSelfPollingArgs('corp:user', 'user', '2026-08-01 13:50:00'), [
  '--profile', 'corp:user',
  'chat', 'message', 'list',
  '--user', 'user',
  '--time', '2026-08-01 13:50:00',
  '--direction', 'newer',
  '--limit', '50',
  '--format', 'json',
]);

assert.deepEqual(buildDingTalkConversationPollingArgs(
  'corp:user',
  { channel: 'dingtalk', kind: 'group', id: 'cid-group' },
  '2026-08-01 13:50:00',
), [
  '--profile', 'corp:user',
  'chat', 'message', 'list',
  '--group', 'cid-group',
  '--time', '2026-08-01 13:50:00',
  '--direction', 'older',
  '--limit', '50',
  '--format', 'json',
]);
assert.deepEqual(buildDingTalkConversationPollingArgs(
  'corp:user',
  { channel: 'dingtalk', kind: 'user', id: 'open-friend' },
  '2026-08-01 13:50:00',
), [
  '--profile', 'corp:user',
  'chat', 'message', 'list',
  '--open-dingtalk-id', 'open-friend',
  '--time', '2026-08-01 13:50:00',
  '--direction', 'older',
  '--limit', '50',
  '--format', 'json',
]);

{
  const payloads = normalizeDingTalkSelfMessages({
    success: true,
    result: {
      messages: [{
        content: '自聊测试',
        createTime: '2026-08-01 13:54:54',
        openConversationId: 'cid-self',
        openMessageId: 'msg-self-1',
        senderOpenDingTalkId: 'open-self',
      }, {
        content: '[文件] 周报.pdf fileId: outbound-file-id 注意：如需下载使用dws drive download命令下载',
        createTime: '2026-08-01 13:54:55',
        openConversationId: 'cid-self',
        openMessageId: 'msg-self-file',
        senderOpenDingTalkId: 'open-self',
      }],
    },
  });
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].message.message_id, 'dingtalk:msg-self-1');
  assert.equal(payloads[0].message.chat_id, 'dingtalk:user:open-self');
  assert.equal(payloads[0].message.chat_type, 'p2p');
  assert.equal(JSON.parse(payloads[0].message.content).text, '自聊测试');
  assert.equal(payloads[0].sender.sender_id.open_id, 'dingtalk:open-self');
  assert.equal(payloads[0].metadata.selfChat, true);
}

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
    { channel: 'dingtalk', kind: 'group', id: 'cid-group' },
    '<@sender-1>\nIssue 已更新',
    'mention-uuid',
    { atOpenDingTalkIds: ['sender-1'] },
  );
  assert.ok(args.includes('--at-open-dingtalk-ids'));
  assert.equal(args[args.indexOf('--at-open-dingtalk-ids') + 1], 'sender-1');
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
