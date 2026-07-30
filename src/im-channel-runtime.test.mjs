import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  DingTalkChannel,
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

console.log('IM_CHANNEL_RUNTIME_TEST_OK');
