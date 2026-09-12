import assert from 'node:assert/strict';
import test from 'node:test';

import { createPagesProxy } from './_worker.js';

test('proxies method, path, query, headers and body to the durable relay worker', async () => {
  let forwarded;
  const proxy = createPagesProxy({
    upstreamOrigin: 'https://aipro-wechat-relay.494161546.workers.dev',
    fetchImpl: async request => {
      forwarded = request;
      return new Response('ok', { status: 200 });
    },
  });
  const response = await proxy.fetch(new Request('https://stable.pages.dev/relay/ack?x=1', {
    method: 'POST', headers: { authorization: 'Bearer secret' }, body: '{"ids":[]}',
  }));
  assert.equal(response.status, 200);
  assert.equal(forwarded.url, 'https://aipro-wechat-relay.494161546.workers.dev/relay/ack?x=1');
  assert.equal(forwarded.method, 'POST');
  assert.equal(forwarded.headers.get('authorization'), 'Bearer secret');
  assert.equal(await forwarded.text(), '{"ids":[]}');
});
