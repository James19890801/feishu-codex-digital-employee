import assert from 'node:assert/strict';
import {
  groundEnterpriseChatKnowledgeTask,
  resolveRealtimeKnowledge,
} from './knowledge-router.mjs';

let enterpriseChatCalls = 0;
let feishuCalls = 0;
const enterpriseChatResult = await resolveRealtimeKnowledge({
  channel: 'enterpriseChat',
  resolveEnterpriseChat: async () => {
    enterpriseChatCalls += 1;
    return { source: 'enterpriseChat', documents: [{ content: '# 正文' }] };
  },
  resolveFeishu: async () => {
    feishuCalls += 1;
    return { source: 'feishu' };
  },
});
assert.equal(enterpriseChatResult.source, 'enterpriseChat');
assert.equal(enterpriseChatCalls, 1);
assert.equal(feishuCalls, 0);

const feishuResult = await resolveRealtimeKnowledge({
  channel: 'feishu',
  resolveEnterpriseChat: async () => {
    enterpriseChatCalls += 1;
    return { source: 'enterpriseChat' };
  },
  resolveFeishu: async () => {
    feishuCalls += 1;
    return { source: 'feishu', documents: [] };
  },
});
assert.equal(feishuResult.source, 'feishu');
assert.equal(enterpriseChatCalls, 1);
assert.equal(feishuCalls, 1);

const unsupported = await resolveRealtimeKnowledge({
  channel: 'wechat',
  resolveEnterpriseChat: async () => { throw new Error('must not call'); },
  resolveFeishu: async () => { throw new Error('must not call'); },
});
assert.equal(unsupported, null);

await assert.rejects(
  resolveRealtimeKnowledge({ channel: 'enterpriseChat', resolveEnterpriseChat: null }),
  /EnterpriseChat resolver/i,
);

const grounded = groundEnterpriseChatKnowledgeTask({
  task: '请总结这份文档',
  result: {
    source: 'enterpriseChat',
    documents: [{
      nodeId: 'nodeABC123',
      title: '接口说明',
      url: 'https://docs.example.com/i/nodes/nodeABC123',
      content: '# 正文',
    }],
    failures: [],
  },
});
assert.match(grounded, /企业会话资料/);
assert.match(grounded, /# 正文/);
assert.match(grounded, /接口说明/);
assert.match(grounded, /https:\/\/docs\.example\.com\/i\/nodes\/nodeABC123/);
assert.doesNotMatch(grounded, /飞书/);

const unavailableTask = groundEnterpriseChatKnowledgeTask({
  task: '请总结这份文档',
  result: {
    source: 'enterpriseChat', documents: [], failures: [{ reason: 'read_failed' }], unavailable: true,
  },
});
assert.match(unavailableTask, /企业会话文档.*没有读取成功/);
assert.match(unavailableTask, /不要猜测/);
assert.doesNotMatch(unavailableTask, /飞书/);

const notFoundTask = groundEnterpriseChatKnowledgeTask({
  task: '查找接口说明',
  result: { source: 'enterpriseChat', documents: [], failures: [], notFound: true },
});
assert.match(notFoundTask, /没有找到匹配的企业会话文档/);
assert.match(notFoundTask, /直接发送文档链接/);

console.log('KNOWLEDGE_ROUTER_TEST_OK');
