import assert from 'node:assert/strict';
import {
  buildDingTalkReadArgs,
  buildDingTalkSearchArgs,
  extractDingTalkDocumentRefs,
  normalizeDingTalkSearchResults,
} from './dingtalk-knowledge.mjs';

const directUrl = 'https://alidocs.dingtalk.com/i/nodes/nodeABC123?utm_medium=im_card';

assert.deepEqual(extractDingTalkDocumentRefs(`请查看 ${directUrl}`), [{
  nodeId: 'nodeABC123',
  url: directUrl,
}]);

assert.deepEqual(extractDingTalkDocumentRefs(
  `${directUrl}\n${directUrl}\nhttps://alidocs.dingtalk.com/i/nodes/nodeSecond9`,
), [
  { nodeId: 'nodeABC123', url: directUrl },
  { nodeId: 'nodeSecond9', url: 'https://alidocs.dingtalk.com/i/nodes/nodeSecond9' },
]);

assert.deepEqual(extractDingTalkDocumentRefs(
  'https://alidocs.dingtalk.com.evil.test/i/nodes/nodeStolen1',
), []);
assert.deepEqual(extractDingTalkDocumentRefs(
  'https://alidocs.dingtalk.com/i/nodes/x',
), []);
assert.deepEqual(extractDingTalkDocumentRefs('普通文字，没有文档链接'), []);

assert.deepEqual(buildDingTalkSearchArgs({
  query: ' 会话级文件直传接口 ',
  profile: 'corp:user',
  limit: 8,
}), [
  '--profile', 'corp:user',
  'drive', 'search',
  '--query', '会话级文件直传接口',
  '--limit', '8',
  '--format', 'json',
  '--yes',
]);

assert.deepEqual(buildDingTalkReadArgs({
  node: 'nodeABC123',
  profile: 'corp:user',
}), [
  '--profile', 'corp:user',
  'doc', 'read',
  '--node', 'nodeABC123',
  '--format', 'json',
  '--yes',
]);

assert.throws(
  () => buildDingTalkSearchArgs({ query: '   ', profile: 'corp:user' }),
  /query/i,
);
assert.throws(
  () => buildDingTalkReadArgs({ node: 'bad node', profile: 'corp:user' }),
  /node/i,
);

const searchPayload = {
  doc_results: {
    success: true,
    documents: [
      {
        nodeId: 'nodeRelated1',
        name: '会话文件接口说明',
        docUrl: 'https://alidocs.dingtalk.com/i/nodes/nodeRelated1',
        contentType: 'ALIDOC',
      },
      {
        nodeId: 'nodeExact12',
        name: '会话级文件直传接口',
        docUrl: 'https://alidocs.dingtalk.com/i/nodes/nodeExact12',
        contentType: 'ALIDOC',
      },
      {
        nodeId: 'nodeContains3',
        name: '会话级文件直传接口补充说明',
        docUrl: 'https://alidocs.dingtalk.com/i/nodes/nodeContains3',
        contentType: 'ALIDOC',
      },
    ],
    hasMore: false,
    nextPageToken: '',
  },
  drive_results: {
    success: true,
    items: [{ fileId: 'ordinary-file', name: '会话级文件直传接口.pdf' }],
    hasMore: false,
  },
};

assert.deepEqual(
  normalizeDingTalkSearchResults(searchPayload, '会话级文件直传接口', 3)
    .map(item => item.nodeId),
  ['nodeExact12', 'nodeContains3', 'nodeRelated1'],
);
assert.deepEqual(
  normalizeDingTalkSearchResults({
    doc_results: { success: false, documents: [] },
    drive_results: { success: true, items: [] },
  }, '接口', 3),
  [],
);
assert.deepEqual(normalizeDingTalkSearchResults({}, '接口', 3), []);

console.log('DINGTALK_KNOWLEDGE_TEST_OK');
