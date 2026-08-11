import assert from 'node:assert/strict';
import {
  groundDingTalkKnowledgeTask,
  resolveRealtimeKnowledge,
} from './knowledge-router.mjs';

let dingtalkCalls = 0;
let feishuCalls = 0;
const dingtalkResult = await resolveRealtimeKnowledge({
  channel: 'dingtalk',
  resolveDingTalk: async () => {
    dingtalkCalls += 1;
    return { source: 'dingtalk', documents: [{ content: '# 正文' }] };
  },
  resolveFeishu: async () => {
    feishuCalls += 1;
    return { source: 'feishu' };
  },
});
assert.equal(dingtalkResult.source, 'dingtalk');
assert.equal(dingtalkCalls, 1);
assert.equal(feishuCalls, 0);

const feishuResult = await resolveRealtimeKnowledge({
  channel: 'feishu',
  resolveDingTalk: async () => {
    dingtalkCalls += 1;
    return { source: 'dingtalk' };
  },
  resolveFeishu: async () => {
    feishuCalls += 1;
    return { source: 'feishu', documents: [] };
  },
});
assert.equal(feishuResult.source, 'feishu');
assert.equal(dingtalkCalls, 1);
assert.equal(feishuCalls, 1);

const unsupported = await resolveRealtimeKnowledge({
  channel: 'wechat',
  resolveDingTalk: async () => { throw new Error('must not call'); },
  resolveFeishu: async () => { throw new Error('must not call'); },
});
assert.equal(unsupported, null);

await assert.rejects(
  resolveRealtimeKnowledge({ channel: 'dingtalk', resolveDingTalk: null }),
  /DingTalk resolver/i,
);

const grounded = groundDingTalkKnowledgeTask({
  task: '请总结这份文档',
  result: {
    source: 'dingtalk',
    documents: [{
      nodeId: 'nodeABC123',
      title: '接口说明',
      url: 'https://alidocs.dingtalk.com/i/nodes/nodeABC123',
      content: '# 正文',
    }],
    failures: [],
  },
});
assert.match(grounded, /钉钉资料/);
assert.match(grounded, /# 正文/);
assert.match(grounded, /接口说明/);
assert.match(grounded, /https:\/\/alidocs\.dingtalk\.com\/i\/nodes\/nodeABC123/);
assert.doesNotMatch(grounded, /飞书/);

const unavailableTask = groundDingTalkKnowledgeTask({
  task: '请总结这份文档',
  result: {
    source: 'dingtalk', documents: [], failures: [{ reason: 'read_failed' }], unavailable: true,
  },
});
assert.match(unavailableTask, /钉钉文档.*没有读取成功/);
assert.match(unavailableTask, /不要猜测/);
assert.doesNotMatch(unavailableTask, /飞书/);

const notFoundTask = groundDingTalkKnowledgeTask({
  task: '查找接口说明',
  result: { source: 'dingtalk', documents: [], failures: [], notFound: true },
});
assert.match(notFoundTask, /没有找到匹配的钉钉文档/);
assert.match(notFoundTask, /直接发送文档链接/);

console.log('KNOWLEDGE_ROUTER_TEST_OK');
