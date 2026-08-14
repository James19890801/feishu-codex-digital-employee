import assert from 'node:assert/strict';
import {
  createPinnedLookup,
  extractHttpUrls,
  extractReadableWebText,
  isPublicAddress,
  readPublicWebPage,
  resolveInboundLinkUrls,
} from './web-reader.mjs';

assert.deepEqual(extractHttpUrls('官网是 https://example.com/docs?a=1，看看。'), [
  'https://example.com/docs?a=1',
]);
assert.deepEqual(extractHttpUrls(
  '群链接：https://github.com/deepseek-ai/deepseek-harness?utm_source=wechat&amp;tab=readme',
), ['https://github.com/deepseek-ai/deepseek-harness?utm_source=wechat&tab=readme']);
assert.deepEqual(resolveInboundLinkUrls({
  text: '卡片解析后的标题',
  linkCandidate: { url: 'https://mp.weixin.qq.com/s/article-id' },
  limit: 3,
}), ['https://mp.weixin.qq.com/s/article-id']);
assert.deepEqual(resolveInboundLinkUrls({
  text: '另一个链接 https://example.com/two',
  linkCandidate: { url: 'https://example.com/one' },
  limit: 2,
}), ['https://example.com/one', 'https://example.com/two']);
assert.equal(isPublicAddress('127.0.0.1'), false);
assert.equal(isPublicAddress('169.254.169.254'), false);
assert.equal(isPublicAddress('10.0.0.8'), false);
assert.equal(isPublicAddress('100.64.0.1'), false);
assert.equal(isPublicAddress('192.0.2.10'), false);
assert.equal(isPublicAddress('198.18.0.1'), false);
assert.equal(isPublicAddress('203.0.113.10'), false);
assert.equal(isPublicAddress('2001:db8::10'), false);
assert.equal(isPublicAddress('8.8.8.8'), true);

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
  <html><head><title>AIPRO Docs</title><style>.hidden{}</style></head>
  <body><nav>Menu</nav><main><h1>Multimodal</h1><p>Images and voice are supported.</p></main>
  <script>alert(1)</script></body></html>
`), /Multimodal\nImages and voice are supported\./);

const calls = [];
const page = await readPublicWebPage('https://docs.example.test/start', {
  lookup: async hostname => {
    assert.equal(hostname, 'docs.example.test');
    return [{ address: '93.184.216.34', family: 4 }];
  },
  fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response('<html><head><title>Guide</title></head><body><main><p>Hello AIPRO</p></main></body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  },
  dispatcherFactory: () => ({ close: async () => {} }),
});
assert.equal(page.title, 'Guide');
assert.match(page.text, /Hello AIPRO/);
assert.equal(calls.length, 1);
assert.equal(calls[0].options.redirect, 'manual');

const githubCalls = [];
const githubPage = await readPublicWebPage('https://github.com/deepseek-ai/deepseek-harness', {
  lookup: async hostname => {
    assert.equal(hostname, 'raw.githubusercontent.com');
    return [{ address: '185.199.108.133', family: 4 }];
  },
  fetchImpl: async url => {
    githubCalls.push(String(url));
    return new Response('# DeepSeek Harness\nEverything is a plugin.', {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
  dispatcherFactory: () => ({ close: async () => {} }),
});
assert.equal(
  githubCalls[0],
  'https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/HEAD/README.md',
);
assert.equal(githubPage.url, 'https://github.com/deepseek-ai/deepseek-harness');
assert.match(githubPage.text, /Everything is a plugin/);

let wechatUserAgent = '';
const wechatPage = await readPublicWebPage('https://mp.weixin.qq.com/s/example', {
  lookup: async hostname => {
    assert.equal(hostname, 'mp.weixin.qq.com');
    return [{ address: '101.91.37.90', family: 4 }];
  },
  fetchImpl: async (_url, options) => {
    wechatUserAgent = options.headers['user-agent'];
    return new Response('<html><body><main><p>公众号文章正文内容可正常读取。</p></main></body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  },
  dispatcherFactory: () => ({ close: async () => {} }),
});
assert.match(wechatUserAgent, /^Mozilla\/5\.0/);
assert.match(wechatPage.text, /公众号文章正文内容/);

const largeWechatHtml = `<html><body><script>${'x'.repeat(3 * 1024 * 1024)}</script><main>大体积公众号正文</main></body></html>`;
const largeWechatPage = await readPublicWebPage('https://mp.weixin.qq.com/s/large', {
  lookup: async () => [{ address: '101.91.37.90', family: 4 }],
  fetchImpl: async () => new Response(largeWechatHtml, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  }),
  dispatcherFactory: () => ({ close: async () => {} }),
});
assert.match(largeWechatPage.text, /大体积公众号正文/);

await assert.rejects(
  readPublicWebPage('https://mp.weixin.qq.com/s/verify', {
    lookup: async () => [{ address: '101.91.37.90', family: 4 }],
    fetchImpl: async () => new Response('<html><body>环境异常，请完成验证后继续访问</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
    dispatcherFactory: () => ({ close: async () => {} }),
  }),
  /verification/i,
);

await assert.rejects(
  readPublicWebPage('http://localhost/private', {
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    fetchImpl: async () => { throw new Error('must not fetch'); },
  }),
  /not public/i,
);

console.log('WEB_READER_TEST_OK');
