import assert from 'node:assert/strict';
import {
  canReadDocument,
  extractKnowledgeQuery,
  looksLikeKnowledgeRequest,
  normalizeKnowledgeText,
  resolveCatalogDocument,
  sourceLine,
  stripHighlight,
  tokenFromSearchResult,
} from './knowledge.mjs';

const catalog = [{
  token: 'abc123', title: '智能纪要：AI专题学习会 2026年7月1日',
  url: 'https://x.feishu.cn/docx/abc123',
  aliases: ['7月1日会议', '7月1号会议', '上次AI学习会'],
  readerOpenIds: ['reader-1'],
}];

assert.equal(normalizeKnowledgeText('7 月 1 号会议？'), '7月1日会议');
assert.equal(looksLikeKnowledgeRequest('帮我总结一下7月1日的会议内容'), true);
assert.equal(looksLikeKnowledgeRequest('上面两张照片包含什么内容'), false);
assert.equal(looksLikeKnowledgeRequest('帮我查一下飞书里的会议纪要'), true);
assert.equal(extractKnowledgeQuery('帮我总结一下7月1日的会议内容'), '7月1日的会议内容');
assert.equal(resolveCatalogDocument('7月1号会议讲了什么', catalog)?.token, 'abc123');
assert.equal(resolveCatalogDocument('https://x.feishu.cn/docx/abc123', catalog)?.token, 'abc123');
assert.equal(resolveCatalogDocument('https://x.feishu.cn/docx/notallowed', catalog)?.denied, true);
assert.equal(canReadDocument(catalog[0], 'owner', 'owner'), true);
assert.equal(canReadDocument(catalog[0], 'reader-1', 'owner'), true);
assert.equal(canReadDocument(catalog[0], 'reader-2', 'owner'), false);
assert.equal(tokenFromSearchResult({ result_meta: { token: 'xyz' } }), 'xyz');
assert.equal(stripHighlight('<em>AI</em>专题学习会'), 'AI专题学习会');
assert.match(sourceLine(catalog[0]), /来源：/);

console.log('KNOWLEDGE_TEST_OK');
