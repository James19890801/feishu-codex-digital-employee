import assert from 'node:assert/strict';
import {
  createPinnedLookup,
  extractHttpUrls,
  extractReadableWebText,
  isPublicAddress,
  readPublicWebPage,
} from './web-reader.mjs';

assert.deepEqual(extractHttpUrls('官网是 https://example.com/docs?a=1，看看。'), [
  'https://example.com/docs?a=1',
]);
assert.deepEqual(extractHttpUrls(
  '先看 https://one.example/a，再看 https://one.example/a，最后 https://two.example/b。',
  2,
), ['https://one.example/a', 'https://two.example/b']);
assert.deepEqual(extractHttpUrls(
  '文档 https://alidocs.dingtalk.com/i/nodes/nodeABC123 官网 https://example.com/guide',
  2,
), ['https://example.com/guide']);
assert.deepEqual(extractHttpUrls(
  '伪造地址 https://alidocs.dingtalk.com.evil.test/i/nodes/nodeABC123',
  2,
), ['https://alidocs.dingtalk.com.evil.test/i/nodes/nodeABC123']);
assert.equal(isPublicAddress('127.0.0.1'), false);
assert.equal(isPublicAddress('169.254.169.254'), false);
assert.equal(isPublicAddress('10.0.0.8'), false);
assert.equal(isPublicAddress('100.64.0.1'), false);
assert.equal(isPublicAddress('192.0.2.10'), false);
assert.equal(isPublicAddress('198.18.0.1'), false);
assert.equal(isPublicAddress('203.0.113.10'), false);
assert.equal(isPublicAddress('2001:db8::10'), false);
assert.equal(isPublicAddress('::1'), false);
assert.equal(isPublicAddress('fc00::1'), false);
assert.equal(isPublicAddress('8.8.8.8'), true);
assert.equal(isPublicAddress('2606:4700:4700::1111'), true);

const pinnedLookup = createPinnedLookup([
  { address: '93.184.216.34', family: 4 },
  { address: '2606:4700:4700::1111', family: 6 },
]);
await new Promise((resolve, reject) => pinnedLookup('docs.example.test', { all: true }, (error, records) => {
  try {
    assert.ifError(error);
    assert.deepEqual(records, [
      { address: '93.184.216.34', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]);
    resolve();
  } catch (failure) { reject(failure); }
}));
assert.match(extractReadableWebText(`
  <html><head><title>James Docs</title><style>.hidden{}</style></head>
  <body><nav>Menu</nav><main><h1>Multimodal</h1><p>Images and voice are supported.</p></main>
  <script>alert(1)</script></body></html>
`), /Multimodal\nImages and voice are supported\./);

const calls = [];
let closeCount = 0;
const page = await readPublicWebPage('https://docs.example.test/start', {
  lookup: async hostname => {
    assert.equal(hostname, 'docs.example.test');
    return [{ address: '93.184.216.34', family: 4 }];
  },
  fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response('<html><head><title>Guide</title></head><body><main><p>Hello James</p></main></body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  },
  dispatcherFactory: () => ({ close: async () => { closeCount += 1; } }),
});
assert.equal(page.title, 'Guide');
assert.match(page.text, /Hello James/);
assert.equal(calls.length, 1);
assert.equal(calls[0].options.redirect, 'manual');
assert.equal(closeCount, 1);

await assert.rejects(
  readPublicWebPage('http://localhost/private', {
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    fetchImpl: async () => { throw new Error('must not fetch'); },
  }),
  /not public/i,
);
await assert.rejects(
  readPublicWebPage('https://docs.example.test:8443/private'),
  /custom ports/i,
);
await assert.rejects(
  readPublicWebPage('https://docs.example.test/image', {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async () => new Response('PNG', {
      status: 200, headers: { 'content-type': 'image/png' },
    }),
    dispatcherFactory: () => ({ close: async () => {} }),
  }),
  /unsupported web content type/i,
);
await assert.rejects(
  readPublicWebPage('https://docs.example.test/large', {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async () => new Response('large', {
      status: 200, headers: { 'content-type': 'text/plain', 'content-length': '999' },
    }),
    dispatcherFactory: () => ({ close: async () => {} }),
    maxBytes: 10,
  }),
  /exceeds size limit/i,
);

console.log('WEB_READER_TEST_OK');
