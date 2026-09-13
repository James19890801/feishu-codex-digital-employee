import test from 'node:test';
import assert from 'node:assert/strict';
import { consumeShadowOnce, createCloudWechatWorker, createCloudGeWeClient } from './cloud-consumer.mjs';

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
