import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';

import { createRelayProxyServer } from './server.mjs';

test('streams arbitrary relay paths and bodies to the Cloudflare upstream', async () => {
  let forwarded;
  const server = createRelayProxyServer({
    upstreamOrigin: 'https://aipro-wechat-relay.494161546.workers.dev',
    fetchImpl: async request => {
      forwarded = request;
      return Response.json({ ok: true }, {
        status: 200,
        headers: { 'x-relay': 'yes', 'content-encoding': 'br', 'content-length': '999' },
      });
    },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/webhooks/gewe/secret?x=1`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}',
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-relay'), 'yes');
    assert.equal(response.headers.get('content-encoding'), null);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(forwarded.url, 'https://aipro-wechat-relay.494161546.workers.dev/webhooks/gewe/secret?x=1');
    assert.equal(await forwarded.text(), '{"a":1}');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('exposes a local liveness endpoint without an upstream request', async () => {
  let calls = 0;
  const server = createRelayProxyServer({
    upstreamOrigin: 'https://aipro-wechat-relay.494161546.workers.dev',
    fetchImpl: async () => { calls += 1; throw new Error('not expected'); },
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/_proxy/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, service: 'aipro-wechat-ingress' });
    assert.equal(calls, 0);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
