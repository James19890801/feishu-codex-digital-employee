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
    ownerIds: ['owner-1'],
    run: async (bin, args) => {
      calls.push({ bin, args });
      return {
        stdout: '{"success":true,"result":{"messageId":"message-direct-1"}}',
        stderr: '',
      };
    },
    onStatus: status => statuses.push(status),
  });
  assert.deepEqual(channel.consumerArgs(), [
    '--profile', 'corp:user',
    'event', 'consume',
    'user_im_message_receive_at',
    'user_im_message_receive_o2o_all',
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
  assert.equal(channel.handleLine(JSON.stringify({
    type: 'user_im_message_receive_o2o_all',
    event_id: 'event-owner-outbound',
    message_id: 'message-owner-outbound',
    sender_open_dingtalk_id: 'owner-1',
    content: '数字人的发送回声',
  }), payload => messages.push(payload)), false);
  assert.equal(messages.length, 1);
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
  const calls = [];
  const channel = new DingTalkChannel({
    bin: '/opt/dws',
    profile: 'corp:user',
    transport: 'event-stream',
    run: async (bin, args) => {
      calls.push({ bin, args });
      if (args.includes('query-send-status')) {
        return {
          stdout: JSON.stringify({
            success: true,
            result: {
              sendStatus: 'SUCCESS',
              messageId: 'message-terminal-1',
            },
          }),
          stderr: '',
        };
      }
      return {
        stdout: JSON.stringify({
          success: true,
          result: { openTaskId: 'task-event-stream-1' },
        }),
        stderr: '',
      };
    },
  });

  const result = await channel.send(
    { channel: 'dingtalk', kind: 'user', id: 'open-colleague' },
    '这是一段可能被钉钉重排的长 Markdown。',
    'event-stream-send-1',
  );

  assert.equal(calls.length, 2, 'event-stream delivery must query terminal send status');
  assert.deepEqual(calls[1].args, [
    '--profile', 'corp:user',
    'chat', 'message', 'query-send-status',
    '--open-task-id', 'task-event-stream-1',
    '--format', 'json',
  ]);
  assert.equal(result.result.messageId, 'message-terminal-1');
  assert.equal(result.result.sendStatus, 'SUCCESS');
}

{
  const calls = [];
  let statusQueries = 0;
  const channel = new DingTalkChannel({
    bin: '/opt/dws',
    profile: 'corp:user',
    transport: 'event-stream',
    sleep: async () => {},
    sendStatusAttempts: 3,
    run: async (bin, args) => {
      calls.push({ bin, args });
      if (!args.includes('query-send-status')) {
        return {
          stdout: JSON.stringify({
            success: true,
            result: { openTaskId: 'task-delayed-1' },
          }),
          stderr: '',
        };
      }
      statusQueries += 1;
      return {
        stdout: JSON.stringify(statusQueries === 1
          ? { success: true, result: { sendStatus: 'PROCESSING' } }
          : {
              success: true,
              result: {
                sendStatus: 'SUCCESS',
                messageId: 'message-delayed-1',
              },
            }),
        stderr: '',
      };
    },
  });

  const result = await channel.send(
    { channel: 'dingtalk', kind: 'user', id: 'open-colleague' },
    '等待终态后登记回声。',
    'event-stream-delayed-1',
  );

  assert.equal(calls.length, 3, 'a non-terminal status must be queried again');
  assert.equal(result.result.messageId, 'message-delayed-1');
}

{
  const channel = new DingTalkChannel({
    bin: '/opt/dws',
    profile: 'corp:user',
    transport: 'event-stream',
    run: async () => ({ stdout: '{"success":true,"result":{}}', stderr: '' }),
  });

  await assert.rejects(
    channel.send(
      { channel: 'dingtalk', kind: 'user', id: 'open-colleague' },
      '没有可核验回执的消息不能算发送完成。',
      'event-stream-no-receipt-1',
    ),
    /no (?:messageId|openTaskId)/i,
  );
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
        json: async () => ({ ret: 200, msg: '操作成功', data: true }),
      };
    },
    now: () => now,
    sleep: async ms => { now += ms; },
    onStatus: status => statuses.push(status),
  });

  assert.equal(await channel.checkOnline(), true);
  assert.equal(calls[0].url, 'https://api.geweapi.com/gewe/v2/api/login/checkOnline');
  assert.equal(calls[0].options.headers['X-GEWE-TOKEN'], 'super-secret-token');
  assert.deepEqual(JSON.parse(calls[0].options.body), { appId: 'device-a' });

  await channel.setCallback('https://james.example.com/webhooks/gewe/callback_secret_1234567890123456');
  assert.equal(calls[1].url, 'https://api.geweapi.com/gewe/v2/api/login/setCallback');
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    token: 'super-secret-token',
    callbackUrl: 'https://james.example.com/webhooks/gewe/callback_secret_1234567890123456',
  });
  await assert.rejects(
    channel.setCallback('http://james.example.com/webhooks/gewe/insecure'),
    /https/i,
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
