import assert from 'node:assert/strict';
import test from 'node:test';
import { AliyunControlClient } from './aliyun-control-client.mjs';

test('sends main-process heartbeat only to HTTPS coordinator with dedicated bearer', async () => {
  const calls = [];
  const client = new AliyunControlClient({ baseUrl: 'https://wxrelay.example',
    tokenSupplier: async () => 'dedicated-control-token',
    fetchImpl: async (url, options) => { calls.push({ url, options });
      return Response.json({ ok: true, accepted: true, generation: 3 }); },
  });
  const snapshot = { generation: 3, bootId: 'boot-test', policyDigest: 'a'.repeat(64),
    criticalStateSequence: 8, channels: { wechat: true, dingtalk: true } };
  assert.deepEqual(await client.heartbeat(snapshot), { accepted: true, generation: 3 });
  assert.equal(calls[0].url, 'https://wxrelay.example/control/main-heartbeat');
  assert.equal(calls[0].options.headers.authorization, 'Bearer dedicated-control-token');
  assert.deepEqual(JSON.parse(calls[0].options.body), snapshot);
  assert.throws(() => new AliyunControlClient({ baseUrl: 'http://wxrelay.example',
    tokenSupplier: async () => 'token' }), /HTTPS/);
});

test('never treats a rejected or malformed coordinator heartbeat as healthy', async () => {
  const make = fetchImpl => new AliyunControlClient({ baseUrl: 'https://wxrelay.example',
    tokenSupplier: async () => 'token', fetchImpl });
  await assert.rejects(make(async () => Response.json({ ok: true, accepted: false }, { status: 200 }))
    .heartbeat({}), /rejected/);
  await assert.rejects(make(async () => new Response('error', { status: 503 }))
    .heartbeat({}), /unavailable/);
  await assert.rejects(make(async () => new Response('not-json', { status: 200 }))
    .heartbeat({}), /invalid/);
});

test('reads fenced local generation without disclosing bearer or accepting cloud ownership', async () => {
  const client = new AliyunControlClient({ baseUrl: 'https://wxrelay.example',
    tokenSupplier: async () => 'dedicated-control-token',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://wxrelay.example/control/status');
      assert.equal(options.headers.authorization, 'Bearer dedicated-control-token');
      return Response.json({ ok: true, state: 'LOCAL_PRIMARY', owner: 'mac', generation: 7 });
    },
  });
  assert.deepEqual(await client.status(), { state: 'LOCAL_PRIMARY', owner: 'mac', generation: 7 });
  const cloud = new AliyunControlClient({ baseUrl: 'https://wxrelay.example',
    tokenSupplier: async () => 'dedicated-control-token', fetchImpl: async () =>
      Response.json({ ok: true, state: 'CLOUD_ACTIVE', owner: 'cloud', generation: 8 }),
  });
  assert.deepEqual(await cloud.status(), { state: 'CLOUD_ACTIVE', owner: 'cloud', generation: 8 });
  await assert.rejects(cloud.localGeneration(), /local_not_leader/);
});

test('initializes a disabled coordinator exactly once through the control credential', async () => {
  const calls = [];
  const client = new AliyunControlClient({ baseUrl: 'https://wxrelay.example',
    tokenSupplier: async () => 'dedicated-control-token', fetchImpl: async (url, options) => {
      calls.push([url, options]);
      return Response.json(url.endsWith('/control/status')
        ? { ok: true, state: 'DISABLED', owner: null, generation: 0 }
        : { ok: true, state: 'LOCAL_PRIMARY', owner: 'mac', generation: 1 });
    },
  });
  assert.equal(await client.localGeneration(), 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], 'https://wxrelay.example/control/start');
  assert.equal(calls[1][1].method, 'POST');
});
