import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  DingTalkChannel,
  GeWeChannel,
  WeComChannel,
} from './im-channel-runtime.mjs';

{
  const calls = [];
  const statuses = [];
  const messages = [];
  const channel = new DingTalkChannel({
    bin: '/opt/dws',
    profile: 'corp:user',
    run: async (bin, args) => {
      calls.push({ bin, args });
      return { stdout: '{"success":true}', stderr: '' };
    },
    onStatus: status => statuses.push(status),
  });
  assert.deepEqual(channel.consumerArgs(), [
    '--profile', 'corp:user',
    'event', 'consume',
    'user_im_message_receive_at',
    'user_im_message_receive_o2o_all',
    'user_im_message_receive_group_all',
    '--flatten',
    '--format', 'ndjson',
  ]);
  assert.equal(channel.handleStderr('[event] ready event_count=2 bus_pid=123'), true);
  assert.equal(statuses.at(-1).connected, true);
  assert.equal(channel.handleLine(JSON.stringify({
    type: 'user_im_message_receive_o2o_all',
    event_id: 'event-1',
    sender_open_dingtalk_id: 'user-1',
    content: '测试',
  }), payload => messages.push(payload)), true);
  assert.equal(messages[0].message.chat_id, 'dingtalk:user:user-1');
  assert.equal(channel.handleLine('not-json', () => {}), false);

  await channel.send(
    { channel: 'dingtalk', kind: 'group', id: 'group-1' },
    '回复内容',
    'uuid-1',
  );
  assert.equal(calls[0].bin, '/opt/dws');
  assert.deepEqual(calls[0].args.slice(0, 5), [
    '--profile', 'corp:user', 'chat', 'message', 'send',
  ]);
  assert.ok(calls[0].args.includes('--ai-tag=false'));

  await channel.send(
    { channel: 'dingtalk', kind: 'group', id: 'group-1' },
    '<@user-1>\nIssue 已更新',
    'uuid-mention',
    { atOpenDingTalkIds: ['user-1'] },
  );
  assert.equal(
    calls[1].args[calls[1].args.indexOf('--at-open-dingtalk-ids') + 1],
    'user-1',
  );
}

{
  const calls = [];
  const channel = new DingTalkChannel({
    bin: '/opt/wukong/dws',
    profile: 'corp:user',
    transport: 'wukong-polling',
    run: async (bin, args) => {
      calls.push({ bin, args });
      return {
        stdout: JSON.stringify({
          success: true,
          result: { openTaskId: 'task-wukong-1' },
        }),
        stderr: '',
      };
    },
  });
  await channel.send(
    { channel: 'dingtalk', kind: 'user', id: 'open-colleague' },
    '阿充稍后回复你。',
    'wukong-send-1',
  );
  assert.equal(calls[0].bin, '/opt/wukong/dws');
  assert.equal(calls[0].args.includes('--profile'), false);
  assert.equal(calls[0].args.includes('--ai-tag=false'), false);
  assert.equal(calls[0].args.includes('--open-dingtalk-id'), true);
}

{
  const statuses = [];
  const messages = [];
  const sends = [];
  class FakeWSClient extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.isConnected = false;
      FakeWSClient.instance = this;
    }

    connect() {
      this.isConnected = true;
      this.emit('connected');
      this.emit('authenticated');
      return this;
    }

    disconnect() {
      this.isConnected = false;
    }

    async sendMessage(chatId, body) {
      sends.push({ chatId, body });
      return { headers: { req_id: 'sent-1' } };
    }
  }

  const channel = new WeComChannel({
    botId: 'bot-1',
    secret: 'secret-1',
    websocketUrl: 'wss://openws.work.weixin.qq.com',
    ClientClass: FakeWSClient,
    onStatus: status => statuses.push(status),
  });
  channel.start(payload => messages.push(payload));
  assert.equal(FakeWSClient.instance.options.botId, 'bot-1');
  assert.equal(statuses.at(-1).authenticated, true);
  assert.equal(statuses.at(-1).connected, true);

  FakeWSClient.instance.emit('message', {
    headers: { req_id: 'request-1' },
    body: {
      msgid: 'message-1',
      chattype: 'single',
      from: { userid: 'user-1' },
      msgtype: 'text',
      text: { content: '你好' },
    },
  });
  assert.equal(messages[0].message.chat_id, 'wecom:user:user-1');

  await channel.send(
    { channel: 'wecom', kind: 'user', id: 'user-1' },
    '你好，我在。',
  );
  assert.deepEqual(sends, [{
    chatId: 'user-1',
    body: {
      msgtype: 'markdown',
      markdown: { content: '你好，我在。' },
    },
  }]);

  FakeWSClient.instance.emit('error', new Error('network unavailable'));
  assert.equal(statuses.at(-1).connected, false);
  assert.match(statuses.at(-1).lastError.error, /network unavailable/);
  channel.stop();
  assert.equal(FakeWSClient.instance.isConnected, false);
  assert.equal(FakeWSClient.instance.listenerCount('message'), 0);
}

{
  const calls = [];
  const statuses = [];
  let now = 1_000;
  const channel = new GeWeChannel({
    appId: 'device-a',
    token: 'super-secret-token',
    apiBaseUrl: 'https://api.geweapi.com',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ret: 200,
          msg: '操作成功',
          data: String(url).endsWith('/message/downloadImage')
            ? { fileUrl: 'https://media.example.com/image.jpg' }
            : String(url).endsWith('/message/downloadFile')
              ? { fileUrl: 'https://media.example.com/report.pdf' }
            : String(url).endsWith('/personal/getProfile')
              ? { wxid: 'wxid_owner', nickName: '詹老师', mobile: 'private' }
            : String(url).endsWith('/sns/snsList')
              ? {
                  firstPageMd5: 'page-md5',
                  maxId: '14287710653886042616',
                  snsList: [{ id: '14287710653886042616', userName: 'wxid_friend' }],
                }
            : String(url).endsWith('/sns/snsDetails')
              ? {
                  id: '14287710653886042616',
                  userName: 'wxid_friend',
                  commentList: [{ commentId: 1, userName: 'wxid_member', content: '有意思' }],
                }
            : String(url).endsWith('/group/getChatroomInfo')
              ? { chatroomId: 'room@chatroom', nickName: 'AI流程与组织变革交流群' }
            : String(url).endsWith('/group/getChatroomMemberList')
              ? {
                  memberList: [
                    { wxid: 'wxid_member_a', nickName: '成员甲', displayName: '甲老师' },
                    { wxid: 'wxid_member_b', nickName: '成员乙', displayName: null },
                    { wxid: '', nickName: '无效成员' },
                  ],
                }
            : true,
        }),
      };
    },
    now: () => now,
    sleep: async ms => { now += ms; },
    onStatus: status => statuses.push(status),
  });
  assert.equal(channel.requestTimeoutMs, 120_000);

  assert.equal(await channel.checkOnline(), true);
  assert.equal(calls[0].url, 'https://api.geweapi.com/gewe/v2/api/login/checkOnline');
  assert.equal(calls[0].options.headers['X-GEWE-TOKEN'], 'super-secret-token');
  assert.deepEqual(JSON.parse(calls[0].options.body), { appId: 'device-a' });

  await channel.setCallback('https://aipro.example.com/webhooks/gewe/callback_secret_1234567890123456');
  assert.equal(calls[1].url, 'https://api.geweapi.com/gewe/v2/api/login/setCallback');
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    token: 'super-secret-token',
    callbackUrl: 'https://aipro.example.com/webhooks/gewe/callback_secret_1234567890123456',
  });
  await assert.rejects(
    channel.setCallback('http://aipro.example.com/webhooks/gewe/insecure'),
    /https/i,
  );

  calls.length = 0;
  const imageUrl = await channel.downloadImage('<msg><img /></msg>');
  assert.equal(imageUrl, 'https://media.example.com/image.jpg');
  assert.equal(calls[0].url, 'https://api.geweapi.com/gewe/v2/api/message/downloadImage');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    appId: 'device-a',
    xml: '<msg><img /></msg>',
    type: 2,
  });

  calls.length = 0;
  const fileUrl = await channel.downloadFile('<msg><appmsg><type>6</type></appmsg></msg>');
  assert.equal(fileUrl, 'https://media.example.com/report.pdf');
  assert.equal(calls[0].url, 'https://api.geweapi.com/gewe/v2/api/message/downloadFile');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    appId: 'device-a',
    xml: '<msg><appmsg><type>6</type></appmsg></msg>',
  });

  calls.length = 0;
  assert.deepEqual(await channel.getChatroomInfo('room@chatroom'), {
    chatroomId: 'room@chatroom',
    nickName: 'AI流程与组织变革交流群',
  });
  assert.equal(calls[0].url, 'https://api.geweapi.com/gewe/v2/api/group/getChatroomInfo');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    appId: 'device-a',
    chatroomId: 'room@chatroom',
  });
  await assert.rejects(channel.getChatroomInfo('not-a-room'), /chatroom/i);

  calls.length = 0;
  assert.deepEqual(await channel.getChatroomMemberList('room@chatroom'), [
    { memberId: 'wxid_member_a', displayName: '甲老师' },
    { memberId: 'wxid_member_b', displayName: '成员乙' },
  ]);
  assert.equal(calls[0].url, 'https://api.geweapi.com/gewe/v2/api/group/getChatroomMemberList');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    appId: 'device-a',
    chatroomId: 'room@chatroom',
  });
  await assert.rejects(channel.getChatroomMemberList('not-a-room'), /chatroom/i);

  calls.length = 0;
  assert.deepEqual(await channel.getProfile(), {
    wxid: 'wxid_owner',
    nickName: '詹老师',
  });
  assert.equal(calls[0].url, 'https://api.geweapi.com/gewe/v2/api/personal/getProfile');
  assert.deepEqual(JSON.parse(calls[0].options.body), { appId: 'device-a' });

  calls.length = 0;
  assert.deepEqual(await channel.listMoments(), {
    firstPageMd5: 'page-md5',
    maxId: '14287710653886042616',
    snsList: [{ id: '14287710653886042616', userName: 'wxid_friend' }],
  });
  assert.equal(calls[0].url, 'https://api.geweapi.com/gewe/v2/api/sns/snsList');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    appId: 'device-a',
    maxId: 0,
    decrypt: true,
    firstPageMd5: '',
  });

  calls.length = 0;
  assert.deepEqual(await channel.getMomentDetails('14287710653886042616'), {
    id: '14287710653886042616',
    userName: 'wxid_friend',
    commentList: [{ commentId: 1, userName: 'wxid_member', content: '有意思' }],
  });
  assert.equal(calls[0].url, 'https://api.geweapi.com/gewe/v2/api/sns/snsDetails');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    appId: 'device-a',
    snsId: '14287710653886042616',
  });
  await assert.rejects(channel.getMomentDetails('not-an-id'), /sns/i);

  calls.length = 0;
  await channel.commentMoment({
    snsId: '14287710653886042616',
    wxid: 'wxid_friend',
    commentId: 33,
    content: '这个切入点挺实在，关键还是看执行边界。',
  });
  assert.equal(calls[0].url, 'https://api.geweapi.com/gewe/v2/api/sns/commentSns');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    appId: 'device-a',
    snsId: '14287710653886042616',
    operType: 1,
    wxid: 'wxid_friend',
    commentId: 33,
    content: '这个切入点挺实在，关键还是看执行边界。',
  });
  await assert.rejects(channel.commentMoment({
    snsId: '14287710653886042616',
    wxid: '',
    content: '内容',
  }), /wxid/i);
  await assert.rejects(channel.commentMoment({
    snsId: '14287710653886042616',
    wxid: 'wxid_friend',
    commentId: -1,
    content: '内容',
  }), /comment/i);
  await assert.rejects(channel.commentMoment({
    snsId: '14287710653886042616',
    wxid: 'wxid_friend',
    content: '',
  }), /content/i);

  calls.length = 0;
  const preparedMention = await channel.prepareGroupMention(
    { channel: 'wechat', kind: 'group', id: 'room@chatroom' },
    '我来回答这个问题',
    { atWxids: ['wechat:wxid_member_a'] },
  );
  assert.deepEqual(preparedMention, {
    content: '@甲老师\n我来回答这个问题',
    ats: 'wxid_member_a',
  });
  await channel.send(
    { channel: 'wechat', kind: 'group', id: 'room@chatroom' },
    preparedMention.content,
    { ats: preparedMention.ats },
  );
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), {
    appId: 'device-a',
    toWxid: 'room@chatroom',
    content: '@甲老师\n我来回答这个问题',
    ats: 'wxid_member_a',
  });
  await assert.rejects(
    channel.prepareGroupMention(
      { channel: 'wechat', kind: 'group', id: 'room@chatroom' },
      '不能静默降级',
      { atWxids: ['wechat:wxid_missing'] },
    ),
    /member.*not found|群成员/iu,
  );

  calls.length = 0;
  await Promise.all([
    channel.send({ channel: 'wechat', kind: 'user', id: 'wxid_a' }, '第一条'),
    channel.send({ channel: 'wechat', kind: 'group', id: 'room@chatroom' }, '第二条'),
  ]);
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    appId: 'device-a',
    toWxid: 'wxid_a',
    content: '第一条',
  });
  assert.equal(JSON.parse(calls[1].options.body).toWxid, 'room@chatroom');
  assert.ok(now >= 2_000, 'GeWe sends must be serialized with at least a one-second gap');
  assert.equal(statuses.at(-1).lastError, null);

  calls.length = 0;
  await channel.sendFile(
    { channel: 'wechat', kind: 'group', id: 'room@chatroom' },
    {
      fileUrl: 'https://callback.example.com/webhooks/gewe/secret/artifacts/token',
      fileName: 'report.pdf',
    },
  );
  assert.equal(calls[0].url, 'https://api.geweapi.com/gewe/v2/api/message/postFile');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    appId: 'device-a',
    toWxid: 'room@chatroom',
    fileUrl: 'https://callback.example.com/webhooks/gewe/secret/artifacts/token',
    fileName: 'report.pdf',
  });
  await assert.rejects(
    channel.sendFile(
      { channel: 'wechat', kind: 'user', id: 'wxid_a' },
      { fileUrl: 'http://callback.example.com/report.pdf', fileName: 'report.pdf' },
    ),
    /https/i,
  );

  calls.length = 0;
  await channel.sendImage(
    { channel: 'wechat', kind: 'group', id: 'room@chatroom' },
    { imageUrl: 'https://callback.example.com/webhooks/gewe/secret/artifacts/token/process.png' },
  );
  assert.equal(calls[0].url, 'https://api.geweapi.com/gewe/v2/api/message/postImage');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    appId: 'device-a',
    toWxid: 'room@chatroom',
    imgUrl: 'https://callback.example.com/webhooks/gewe/secret/artifacts/token/process.png',
  });
  await assert.rejects(
    channel.sendImage(
      { channel: 'wechat', kind: 'user', id: 'wxid_a' },
      { imageUrl: 'http://callback.example.com/process.png' },
    ),
    /https/i,
  );

  await assert.rejects(
    () => new GeWeChannel({
      appId: 'device-a',
      token: 'secret',
      apiBaseUrl: 'http://api.geweapi.com',
    }).checkOnline(),
    /https/i,
  );
}

console.log('IM_CHANNEL_RUNTIME_TEST_OK');
