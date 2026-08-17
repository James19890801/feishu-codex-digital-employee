import assert from 'node:assert/strict';
import { readOwnerArticlePage } from './wechat-owner-article-reader.mjs';

const title = '流程管理者做 AI 变革，起点不是技术';
const localText = '真正的起点不是选哪个模型，而是找到那些频繁发生、判断密集、反馈缓慢的业务流程。先把问题和责任边界说清楚，AI 才不会只成为新的界面装饰。';

function localIndex(sourceTitle = title) {
  return {
    version: 1,
    sources: [{ handle: 'src_exact', title: sourceTitle, kind: 'html' }],
    chunks: [
      { id: 'src_exact_2', sourceHandle: 'src_exact', safe: true, text: '第二段：把指标、异常和反馈挂到流程上。' },
      { id: 'src_exact_1', sourceHandle: 'src_exact', safe: true, text: localText },
    ],
  };
}

{
  let loadedLocal = false;
  const page = await readOwnerArticlePage('https://mp.weixin.qq.com/s?x=1', { title }, {
    readPublicPage: async () => ({ title, text: `${localText}${localText}` }),
    loadLocalIndex: async () => { loadedLocal = true; return localIndex(); },
  });
  assert.equal(page.source, 'public_web');
  assert.equal(loadedLocal, false);
}

{
  const page = await readOwnerArticlePage('https://mp.weixin.qq.com/s?x=1', { title }, {
    readPublicPage: async () => ({ title: '', text: '验证页' }),
    loadLocalIndex: async () => localIndex(),
  });
  assert.equal(page.source, 'local_exact_title');
  assert.equal(page.title, title);
  assert.match(page.text, /起点不是选哪个模型/);
  assert.match(page.text, /第二段/);
}

await assert.rejects(
  readOwnerArticlePage('https://mp.weixin.qq.com/s?x=1', { title }, {
    readPublicPage: async () => { throw new Error('WeChat article requires browser verification'); },
    loadLocalIndex: async () => localIndex(`${title}详解`),
  }),
  /browser verification/,
);

await assert.rejects(
  readOwnerArticlePage('https://mp.weixin.qq.com/s?x=1', { title }, {
    readPublicPage: async () => ({ title: '', text: '验证页' }),
    loadLocalIndex: async () => ({
      ...localIndex(),
      chunks: [{ id: 'src_exact_1', sourceHandle: 'src_exact', safe: false, text: localText }],
    }),
  }),
  /article_text_unavailable/,
);

console.log('WECHAT_OWNER_ARTICLE_READER_TEST_OK');
