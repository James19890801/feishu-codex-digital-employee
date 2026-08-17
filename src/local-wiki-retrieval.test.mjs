import assert from 'node:assert/strict';
import {
  buildLocalKnowledgeContext,
  decideLocalKnowledgeRetrieval,
  LocalWikiRetriever,
  retrieveLocalKnowledge,
  shouldRetrieveLocalKnowledge,
} from './local-wiki-retrieval.mjs';

assert.equal(shouldRetrieveLocalKnowledge('你好'), false);
assert.equal(shouldRetrieveLocalKnowledge('收到'), false);
assert.equal(shouldRetrieveLocalKnowledge('帮我解释一下 AI 进入流程后，人和多个智能体怎么协同'), true);
assert.equal(shouldRetrieveLocalKnowledge('流程治理应该怎么设计？'), true);
assert.equal(shouldRetrieveLocalKnowledge('今天杭州天气怎么样？'), false);
assert.equal(shouldRetrieveLocalKnowledge('你现在几点？'), false);
assert.equal(shouldRetrieveLocalKnowledge('怎么发朋友圈？'), false);
assert.equal(shouldRetrieveLocalKnowledge('帮我打开这个文件'), false);
assert.equal(shouldRetrieveLocalKnowledge('把这段话回复给他'), false);
assert.equal(shouldRetrieveLocalKnowledge('为什么还没有回复？'), false);
assert.equal(shouldRetrieveLocalKnowledge('写一段关于AI与流程协同的观点'), true);
assert.equal(shouldRetrieveLocalKnowledge('结合我以前写的公众号，谈谈组织协同'), true);
assert.equal(shouldRetrieveLocalKnowledge('帮我评估一下这个商业模式'), true);
assert.equal(shouldRetrieveLocalKnowledge('这个报价策略合理吗？'), true);
assert.equal(shouldRetrieveLocalKnowledge('客户转化率连续下降，应该怎么诊断？'), true);
assert.equal(shouldRetrieveLocalKnowledge('请给出合同审批机制的风险分析'), true);
assert.equal(shouldRetrieveLocalKnowledge('这个 API 为什么返回 401？'), true);
assert.equal(shouldRetrieveLocalKnowledge('微信回调验签应该怎么设计？'), true);
assert.equal(shouldRetrieveLocalKnowledge('打开微信'), false);
assert.equal(shouldRetrieveLocalKnowledge('重启服务'), false);
assert.deepEqual(decideLocalKnowledgeRetrieval('收到'), { retrieve: false, reason: 'conversation' });
assert.deepEqual(decideLocalKnowledgeRetrieval('流程治理应该怎么设计？'), { retrieve: true, reason: 'domain_knowledge' });
assert.deepEqual(decideLocalKnowledgeRetrieval('这个报价策略合理吗？'), { retrieve: true, reason: 'business_professional' });

const index = {
  version: 1,
  chunks: [
    {
      id: 'c1', sourceHandle: 'src_1111111111111111', title: '协同机制',
      text: 'AI 进入流程之后，需要明确多个 AI 之间的任务交接，以及人对目标、判断和最终责任的承担。',
      terms: ['ai', '流程', '协同', '任务', '交接', '目标', '判断', '责任'],
      safe: true,
    },
    {
      id: 'c2', sourceHandle: 'src_2222222222222222', title: '无关内容',
      text: '课程页面的视觉排版可以使用留白和网格。',
      terms: ['课程', '页面', '视觉', '排版'],
      safe: true,
    },
    {
      id: 'c3', sourceHandle: 'src_3333333333333333', title: '敏感材料',
      text: '某客户项目的内部合同金额与联系人信息。',
      terms: ['客户', '项目', '合同', '金额', '联系人'],
      safe: true,
    },
  ],
};

const hit = retrieveLocalKnowledge('AI进入流程后，人和AI之间如何协同与分工？', index, {
  minimumScore: 0.18,
});
assert.equal(hit.used, true);
assert.equal(hit.evidence.length, 1);
assert.equal(hit.evidence[0].sourceHandle, 'src_1111111111111111');

const miss = retrieveLocalKnowledge('今天杭州天气怎么样？', index, { minimumScore: 0.18 });
assert.equal(miss.used, false);
assert.deepEqual(miss.evidence, []);

const context = buildLocalKnowledgeContext(hit);
assert.match(context, /内部知识参考/);
assert.match(context, /最终责任/);
assert.doesNotMatch(context, /src_|Users|客户|项目|本地知识库|来源/);

const retriever = new LocalWikiRetriever({
  loadIndex: async () => index,
  minimumScore: 0.18,
});
const feishuContext = await retriever.contextFor({
  channel: 'feishu', query: 'AI进入流程后如何划分人的责任？',
});
const wechatContext = await retriever.contextFor({
  channel: 'wechat', query: 'AI进入流程后如何划分人的责任？',
});
const enterpriseChatContext = await retriever.contextFor({
  channel: 'enterpriseChat', query: 'AI进入流程后如何划分人的责任？',
});
const weComContext = await retriever.contextFor({
  channel: 'wecom', query: 'AI进入流程后如何划分人的责任？',
});
assert.equal(feishuContext, wechatContext);
assert.equal(feishuContext, enterpriseChatContext);
assert.equal(feishuContext, weComContext);
assert.match(feishuContext, /最终责任/);
assert.equal(retriever.health().lastUsed, true);

let bypassLoadCount = 0;
const bypassed = new LocalWikiRetriever({ loadIndex: async () => { bypassLoadCount += 1; return index; } });
assert.equal(await bypassed.contextFor({ channel: 'wechat', query: '今天杭州天气怎么样？' }), '');
assert.equal(bypassLoadCount, 0);
assert.equal(bypassed.health().lastDecision, 'live_information');
assert.equal(bypassed.health().lastUsed, false);

let nowMs = 1_000;
let refreshLoadCount = 0;
const refreshing = new LocalWikiRetriever({
  loadIndex: async () => { refreshLoadCount += 1; return index; },
  cacheTtlMs: 60_000,
  now: () => nowMs,
});
await refreshing.contextFor({ query: '流程治理应该怎么设计？' });
await refreshing.contextFor({ query: '流程治理应该怎么设计？' });
assert.equal(refreshLoadCount, 1);
nowMs += 60_001;
await refreshing.contextFor({ query: '流程治理应该怎么设计？' });
assert.equal(refreshLoadCount, 2);

const unavailable = new LocalWikiRetriever({ loadIndex: async () => { throw new Error('missing'); } });
assert.equal(await unavailable.contextFor({ channel: 'wechat', query: '流程治理应该怎么设计？' }), '');
assert.equal(unavailable.health().state, 'unavailable');

console.log('LOCAL_WIKI_RETRIEVAL_TEST_OK');
