import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeShadowOnce, createCloudWechatWorker, createCloudGeWeClient, normalizeCloudGeWeText } from './cloud-consumer.mjs';

test('cloud normalizer retains a directly mentioned V1 group message and its actual sender', () => {
  const event = normalizeCloudGeWeText({
    TypeName: 'AddMsg', Appid: 'wx-app', Wxid: 'self-wxid',
    Data: {
      MsgType: 1, NewMsgId: 'group-1',
      FromUserName: { string: 'room-1@chatroom' }, ToUserName: { string: 'self-wxid' },
      Content: { string: 'member-wxid:\n@小詹 帮我看看' },
      MsgSource: '<msgsource><atuserlist><![CDATA[self-wxid]]></atuserlist></msgsource>',
    },
  }, { mentionNames: ['小詹'] });
  assert.equal(event.message.chat_id, 'wechat:group:room-1@chatroom');
  assert.equal(event.sender.sender_id.open_id, 'wechat:member-wxid');
  assert.equal(JSON.parse(event.message.content).text, '@小詹 帮我看看');
  assert.equal(event.metadata.explicitBotMention, true);
});

test('cloud worker never responds to an unmentioned group message even when chat policy allows it', async () => {
  const store = {
    leadershipStatus: () => ({ state: 'CLOUD_ACTIVE', owner: 'cloud', generation: 8 }),
    getCurrentPolicy: () => ({ digest: 'a'.repeat(64), manifest: { sections: {
      config: { data: { allowAllChats: true } }, state: { data: {} }, persona: { data: '' }, instructions: { data: '' },
    } } }),
  };
  const worker = createCloudWechatWorker({ store,
    runtime: { execute: async () => { throw new Error('must not invoke runtime'); } },
    gewe: { sendText: async () => { throw new Error('must not send'); } },
  });
  const result = await worker.process({ body: JSON.stringify({
    TypeName: 'AddMsg', Appid: 'wx-app', Wxid: 'self-wxid',
    Data: { MsgType: 1, NewMsgId: 'group-2', FromUserName: { string: 'room-1@chatroom' },
      ToUserName: { string: 'self-wxid' }, Content: { string: 'member-wxid:\n普通群消息' }, MsgSource: '<msgsource></msgsource>' },
  }) });
  assert.deepEqual(result, { outcome: 'skipped', reason: 'unsupported_callback' });
});

test('cloud worker requires and forwards a resolved group mention before sending', async () => {
  const calls = [];
  const store = {
    leadershipStatus: () => ({ state: 'CLOUD_ACTIVE', owner: 'cloud', generation: 8 }),
    getCurrentPolicy: () => ({ digest: 'a'.repeat(64), manifest: { sections: {
      config: { data: { allowAllChats: true, geweMentionNames: ['小詹'] } }, state: { data: {} }, persona: { data: '' }, instructions: { data: '' },
    } } }),
    claimEvent: () => ({ claimed: true, claimKey: 'c'.repeat(64) }),
    prepareSend: () => ({ shouldSend: true, intentKey: 'i'.repeat(64) }),
    recordSendReceipt: input => calls.push(['receipt', input]), completeClaim: () => {},
  };
  const worker = createCloudWechatWorker({ store, runtime: { execute: async () => ({ text: '收到' }) },
    gewe: { prepareGroupMention: async input => { calls.push(['mention', input]); return { content: '@成员\n收到', ats: 'member-wxid' }; },
      sendText: async input => { calls.push(['send', input]); return { ret: 200, data: { newMsgId: 'reply-1' } }; } },
  });
  const result = await worker.process({ body: JSON.stringify({
    TypeName: 'AddMsg', Appid: 'wx-app', Wxid: 'self-wxid',
    Data: { MsgType: 1, NewMsgId: 'group-3', FromUserName: { string: 'room-1@chatroom' }, ToUserName: { string: 'self-wxid' },
      Content: { string: 'member-wxid:\n@小詹 帮我看看' }, MsgSource: '<msgsource><atuserlist><![CDATA[self-wxid]]></atuserlist></msgsource>' },
  }) });
  assert.equal(result.outcome, 'replied');
  assert.deepEqual(calls.find(([kind]) => kind === 'mention')[1], { chatroomId: 'room-1@chatroom', atWxids: ['member-wxid'], text: '收到' });
  assert.deepEqual(calls.find(([kind]) => kind === 'send')[1], { toWxid: 'room-1@chatroom', content: '@成员\n收到', ats: 'member-wxid', intentKey: 'i'.repeat(64) });
});

test('shadow consumer leases only when cloud owns the generation and never acknowledges', async () => {
  const calls = [];
  const store = { leadershipStatus: () => ({ state: 'CLOUD_ACTIVE', owner: 'cloud', generation: 3 }),
    async lease(value) { calls.push(value); return { events: [{ digest: 'a'.repeat(64), body: JSON.stringify({
      Appid: 'wx-app', Wxid: 'self-wxid', TypeName: 'AddMsg',
      Data: { MsgType: 1, FromUserName: { string: 'friend' }, ToUserName: { string: 'self-wxid' },
        Content: { string: '演练消息' }, NewMsgId: 'shadow-1' },
    }) }] }; },
    async ack() { throw new Error('shadow mode must never ack'); } };
  assert.deepEqual(await consumeShadowOnce({ store, enabled: true, now: 1_000 }),
    { leased: 1, parsed: 1, normalized: 1, malformed: 0, acknowledged: 0, generation: 3 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].leaseMs, 30_000);
});

test('shadow consumer does not lease while Mac remains primary', async () => {
  const store = { leadershipStatus: () => ({ state: 'LOCAL_PRIMARY', owner: 'mac', generation: 1 }),
    async lease() { throw new Error('must not lease'); } };
  assert.deepEqual(await consumeShadowOnce({ store, enabled: true }),
    { leased: 0, parsed: 0, normalized: 0, malformed: 0, acknowledged: 0, skipped: 'not_cloud_leader' });
});

test('real cloud worker normalizes a GeWe text callback and only returns a durable provider receipt', async () => {
  const calls = [];
  const store = {
    leadershipStatus: () => ({ state: 'CLOUD_ACTIVE', owner: 'cloud', generation: 8 }),
    getCurrentPolicy: () => ({ revision: 1, digest: 'a'.repeat(64), manifest: {
      sections: { config: { data: { allowAllChats: true } }, state: { data: {} },
        persona: { data: '小詹' }, bible: { data: '' }, instructions: { data: '' } },
    } }),
    claimEvent: () => ({ claimed: true, claimKey: 'c'.repeat(64) }),
    prepareSend: () => ({ shouldSend: true, intentKey: 'i'.repeat(64) }),
    recordSendReceipt: input => calls.push(['receipt', input]),
    completeClaim: input => calls.push(['complete', input]),
  };
  const worker = createCloudWechatWorker({ store,
    runtime: { execute: async input => { calls.push(['runtime', input]); return { text: '已收到' }; } },
    gewe: { sendText: async input => { calls.push(['send', input]); return { ret: 200, data: { newMsgId: 'msg-42' } }; } },
  });
  const result = await worker.process({ body: JSON.stringify({
    Appid: 'wx-app', Wxid: 'self-wxid', TypeName: 'AddMsg',
    Data: { MsgType: 1, FromUserName: { string: 'friend-wxid' }, ToUserName: { string: 'self-wxid' },
      Content: { string: '你好' }, NewMsgId: 'inbound-7', CreateTime: 1 },
  }) });
  assert.equal(result.outcome, 'replied');
  assert.equal(result.receiptId, 'msg-42');
  assert.equal(calls.find(([kind]) => kind === 'send')[1].toWxid, 'friend-wxid');
  assert.equal(calls.find(([kind]) => kind === 'receipt')[1].status, 'sent');
});

test('cloud GeWe client sends the fenced text with app credentials and rejects a non-200 response', async () => {
  const requests = [];
  const gewe = createCloudGeWeClient({ appId: 'app', token: 't'.repeat(24), fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ ret: 200, data: { newMsgId: 'r-1' } }), { status: 200 });
  } });
  assert.equal((await gewe.sendText({ toWxid: 'wxid', content: 'reply' })).data.newMsgId, 'r-1');
  assert.equal(requests[0].url, 'https://api.geweapi.com/gewe/v2/api/message/postText');
  assert.equal(requests[0].options.headers['X-GEWE-TOKEN'], 't'.repeat(24));
  assert.deepEqual(JSON.parse(requests[0].options.body), { appId: 'app', toWxid: 'wxid', content: 'reply' });
  const failing = createCloudGeWeClient({ appId: 'app', token: 't'.repeat(24), fetchImpl: async () =>
    new Response(JSON.stringify({ ret: 500 }), { status: 200 }) });
  await assert.rejects(failing.sendText({ toWxid: 'wxid', content: 'reply' }), /unconfirmed/);
});
