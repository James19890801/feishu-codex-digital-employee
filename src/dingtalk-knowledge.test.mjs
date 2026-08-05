import assert from 'node:assert/strict';
import {
  buildDingTalkReadArgs,
  buildDingTalkSearchArgs,
  extractDingTalkDocumentRefs,
  normalizeDingTalkSearchResults,
  retrieveDingTalkKnowledge,
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

const directCalls = [];
const directKnowledge = await retrieveDingTalkKnowledge({
  text: '请看 https://alidocs.dingtalk.com/i/nodes/nodeABC123',
  senderId: 'colleague',
  ownerIds: ['owner'],
  catalog: { version: 2, sources: [] },
  profile: 'corp:user',
  runDws: async args => {
    directCalls.push(args);
    return {
      success: true,
      nodeId: 'nodeABC123',
      title: '接口说明',
      markdown: '# 正文',
      docUrl: 'https://alidocs.dingtalk.com/i/nodes/nodeABC123',
    };
  },
});
assert.equal(directKnowledge.source, 'dingtalk');
assert.equal(directKnowledge.documents[0].content, '# 正文');
assert.equal(directCalls.length, 1);
assert.deepEqual(directCalls[0], buildDingTalkReadArgs({
  node: 'nodeABC123',
  profile: 'corp:user',
}));
assert.equal(directCalls[0].includes('search'), false);

const ownerCalls = [];
const ownerKnowledge = await retrieveDingTalkKnowledge({
  text: '帮我查一下会话级文件直传接口文档',
  senderId: 'owner',
  ownerIds: ['owner'],
  catalog: { version: 2, sources: [] },
  profile: 'corp:user',
  runDws: async args => {
    ownerCalls.push(args);
    if (args.includes('search')) {
      return {
        doc_results: {
          success: true,
          documents: [
            { nodeId: 'nodeExact12', name: '会话级文件直传接口', docUrl: 'https://alidocs.dingtalk.com/i/nodes/nodeExact12' },
            { nodeId: 'nodeExtra13', name: '会话级文件直传接口说明一', docUrl: 'https://alidocs.dingtalk.com/i/nodes/nodeExtra13' },
            { nodeId: 'nodeExtra14', name: '会话级文件直传接口说明二', docUrl: 'https://alidocs.dingtalk.com/i/nodes/nodeExtra14' },
            { nodeId: 'nodeExtra15', name: '会话级文件直传接口说明三', docUrl: 'https://alidocs.dingtalk.com/i/nodes/nodeExtra15' },
          ],
          hasMore: false,
          nextPageToken: '',
        },
        drive_results: { success: true, items: [], hasMore: false },
      };
    }
    const nodeId = args[args.indexOf('--node') + 1];
    return {
      success: true,
      nodeId,
      title: `文档 ${nodeId}`,
      markdown: `正文 ${nodeId}`,
      docUrl: `https://alidocs.dingtalk.com/i/nodes/${nodeId}`,
    };
  },
});
assert.equal(ownerKnowledge.source, 'dingtalk');
assert.equal(ownerKnowledge.documents.length, 3);
assert.deepEqual(ownerCalls[0], buildDingTalkSearchArgs({
  query: '会话级文件直传接口文档',
  profile: 'corp:user',
  limit: 8,
}));
assert.equal(ownerCalls.length, 4);

const nonOwnerCalls = [];
const nonOwnerKnowledge = await retrieveDingTalkKnowledge({
  text: '帮我查一下组织战略文档',
  senderId: 'colleague',
  ownerIds: ['owner'],
  catalog: { version: 2, sources: [] },
  profile: 'corp:user',
  runDws: async args => {
    nonOwnerCalls.push(args);
    throw new Error('Non-owner account-wide search must not run');
  },
});
assert.equal(nonOwnerKnowledge.source, 'dingtalk');
assert.equal(nonOwnerKnowledge.notFound, true);
assert.equal(nonOwnerCalls.length, 0);

const catalogCalls = [];
const catalogKnowledge = await retrieveDingTalkKnowledge({
  text: '请总结允许分享的接口说明文档',
  senderId: 'dingtalk:colleague',
  ownerIds: ['owner'],
  catalog: {
    version: 2,
    sources: [{
      sourceId: 'dingtalk-doc:catalog',
      type: 'dingtalk_doc',
      title: '允许分享的接口说明',
      aliases: ['分享接口'],
      locator: 'nodeCatalog1',
      ownerId: 'owner',
      readerIds: ['colleague'],
      status: 'active',
    }],
  },
  profile: 'corp:user',
  runDws: async args => {
    catalogCalls.push(args);
    return {
      success: true,
      nodeId: 'nodeCatalog1',
      title: '允许分享的接口说明',
      markdown: '目录授权正文',
      docUrl: 'https://alidocs.dingtalk.com/i/nodes/nodeCatalog1',
    };
  },
});
assert.equal(catalogKnowledge.documents[0].content, '目录授权正文');
assert.equal(catalogCalls.length, 1);
assert.equal(catalogCalls[0].includes('search'), false);

const boundedKnowledge = await retrieveDingTalkKnowledge({
  text: [
    'https://alidocs.dingtalk.com/i/nodes/nodeBounded1',
    'https://alidocs.dingtalk.com/i/nodes/nodeBounded2',
  ].join('\n'),
  senderId: 'colleague',
  ownerIds: ['owner'],
  catalog: { version: 2, sources: [] },
  profile: 'corp:user',
  maxDocumentChars: 5,
  maxTotalChars: 7,
  runDws: async args => {
    const nodeId = args[args.indexOf('--node') + 1];
    return {
      success: true,
      nodeId,
      title: nodeId,
      markdown: 'abcdef',
      docUrl: `https://alidocs.dingtalk.com/i/nodes/${nodeId}`,
    };
  },
});
assert.deepEqual(boundedKnowledge.documents.map(document => document.content), ['abcde', 'ab']);

const partialKnowledge = await retrieveDingTalkKnowledge({
  text: [
    'https://alidocs.dingtalk.com/i/nodes/nodePartial1',
    'https://alidocs.dingtalk.com/i/nodes/nodePartial2',
  ].join('\n'),
  senderId: 'colleague',
  ownerIds: ['owner'],
  catalog: { version: 2, sources: [] },
  profile: 'corp:user',
  runDws: async args => {
    const nodeId = args[args.indexOf('--node') + 1];
    if (nodeId === 'nodePartial2') throw new Error('sensitive external detail');
    return {
      success: true,
      nodeId,
      title: '可读文档',
      markdown: '可读正文',
    };
  },
});
assert.equal(partialKnowledge.documents.length, 1);
assert.deepEqual(partialKnowledge.failures, [{ nodeId: 'nodePartial2', reason: 'read_failed' }]);
assert.equal(partialKnowledge.unavailable, undefined);
assert.doesNotMatch(JSON.stringify(partialKnowledge), /sensitive external detail/);

const invalidKnowledge = await retrieveDingTalkKnowledge({
  text: 'https://alidocs.dingtalk.com/i/nodes/nodeExpected1',
  senderId: 'colleague',
  ownerIds: ['owner'],
  catalog: { version: 2, sources: [] },
  profile: 'corp:user',
  runDws: async () => ({
    success: true,
    nodeId: 'nodeDifferent2',
    title: '错误文档',
    markdown: '不应采用',
  }),
});
assert.equal(invalidKnowledge.documents.length, 0);
assert.deepEqual(invalidKnowledge.failures, [{
  nodeId: 'nodeExpected1',
  reason: 'invalid_response',
}]);
assert.equal(invalidKnowledge.unavailable, true);

const emptyKnowledge = await retrieveDingTalkKnowledge({
  text: 'https://alidocs.dingtalk.com/i/nodes/nodeEmpty123',
  senderId: 'colleague',
  ownerIds: ['owner'],
  catalog: { version: 2, sources: [] },
  profile: 'corp:user',
  runDws: async () => ({
    success: true,
    nodeId: 'nodeEmpty123',
    title: '空文档',
    markdown: '   ',
  }),
});
assert.deepEqual(emptyKnowledge.failures, [{
  nodeId: 'nodeEmpty123',
  reason: 'empty_content',
}]);
assert.equal(emptyKnowledge.unavailable, true);

console.log('DINGTALK_KNOWLEDGE_TEST_OK');
