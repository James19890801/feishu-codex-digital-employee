import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentState } from './state.mjs';
import {
  parseOwnerArticleDrafts,
  WeChatOwnerArticleSyndication,
} from './wechat-owner-article-syndication.mjs';

const directory = await mkdtemp(join(tmpdir(), 'aipro-owner-article-'));
try {
  const state = new AgentState(join(directory, 'state.sqlite'));
  const comments = [];
  const shares = [];
  const prompts = [];
  let reads = 0;
  let generations = 0;
  const worker = new WeChatOwnerArticleSyndication({
    state,
    readPage: async url => {
      reads += 1;
      return {
        url,
        title: '流程管理者做 AI 变革，起点不是技术',
        text: '企业推动 AI 变革时，真正的起点并不是选模型，而是识别业务问题、重构流程责任，并建立持续反馈。流程管理者的优势，在于熟悉跨部门接口、例外和真实经营约束。',
      };
    },
    generate: async prompt => {
      generations += 1;
      prompts.push(prompt);
      return JSON.stringify({
        articleComment: '流程管理者的真正优势，不是比技术团队更懂模型，而是知道判断发生在哪里、责任断在哪里。AI 变革从业务问题起步，才能避免做出一堆漂亮但没人负责的演示。',
        momentInsight: 'AI 变革的起点往往不是技术，而是谁能把业务问题、流程责任和反馈闭环说清楚。流程管理者未必最懂模型，却可能最知道组织在哪些接口上真正掉链子——这比再开一次工具选型会更值钱。',
      });
    },
    commentArticle: async input => {
      comments.push(input);
      return { submitted: true, receipt: 'comment-1' };
    },
    publishLinkMoment: async input => {
      shares.push(input);
      return { data: { id: '14990001' } };
    },
  });

  const first = await worker.observe({
    senderOpenId: 'wechat:gh_07e3d1422f5e',
    messageId: 'message-1',
    linkCandidate: {
      url: 'http://mp.weixin.qq.com/s?__biz=MzkxMTczNzkyMA==&mid=2247488166&idx=1&sn=bdd47a6f9cf63f43783fbac863076c90&scene=0#rd',
      title: '流程管理者做 AI 变革，起点不是技术',
      description: '从业务问题、流程责任和反馈闭环出发。',
      publisherId: 'gh_07e3d1422f5e',
      publisherName: '詹生talk',
      thumbUrl: 'https://mmbiz.qpic.cn/example/640',
    },
  });
  assert.equal(first.eligible, true);
  assert.equal(first.commented, true);
  assert.equal(first.shared, true);
  assert.equal(reads, 1);
  assert.equal(generations, 1);
  assert.equal(comments.length, 1);
  assert.equal(shares.length, 1);
  assert.match(prompts[0], /真正的起点并不是选模型/);
  assert.equal(comments[0].url.startsWith('https://mp.weixin.qq.com/s?'), true);
  assert.equal(shares[0].title, '流程管理者做 AI 变革，起点不是技术');
  assert.equal(shares[0].thumbUrl, 'https://mmbiz.qpic.cn/example/640');
  assert.notEqual(comments[0].content, shares[0].content);

  const replay = await worker.observe({
    senderOpenId: 'wechat:fung5115',
    messageId: 'message-2',
    linkCandidate: {
      url: 'https://mp.weixin.qq.com/s?sn=bdd47a6f9cf63f43783fbac863076c90&idx=1&mid=2247488166&__biz=MzkxMTczNzkyMA==&mpshare=1&scene=1#rd',
      title: '重复分享',
      publisherId: 'gh_07e3d1422f5e',
    },
  });
  assert.equal(replay.eligible, true);
  assert.equal(replay.replayed, true);
  assert.equal(reads, 1);
  assert.equal(generations, 1);
  assert.equal(comments.length, 1);
  assert.equal(shares.length, 1);

  const persisted = state.get('wechat-owner-article-syndication', 'worker', {});
  assert.equal(persisted.articles.length, 1);
  assert.equal(persisted.articles[0].commentStatus, 'succeeded');
  assert.equal(persisted.articles[0].shareStatus, 'succeeded');
  assert.equal(typeof persisted.articles[0].articleKey, 'string');

  const auditText = state.db.prepare('SELECT detail FROM audit').all()
    .map(row => row.detail).join('\n');
  assert.equal(auditText.includes('流程管理者做 AI 变革'), false);
  assert.equal(auditText.includes('gh_07e3d1422f5e'), false);
  assert.equal(auditText.includes('mp.weixin.qq.com'), false);
  state.close();
} finally {
  await rm(directory, { recursive: true, force: true });
}

{
  const parsed = parseOwnerArticleDrafts(JSON.stringify({
    articleComment: '流程不是画出来的，而是责任、信息和反馈在真实工作中跑出来的。AI 进入流程之后，更要先明确谁对最后结果负责。',
    momentInsight: '很多企业把 AI 项目从模型选型开始，像装修还没画户型就先买灯。真正的起点是业务问题：哪个判断太慢、哪个接口总断、哪个结果没人负责。这一步省不了。',
  }));
  assert.equal(Boolean(parsed), true);
  assert.equal(parseOwnerArticleDrafts('not-json'), null);
  assert.equal(parseOwnerArticleDrafts(JSON.stringify({
    articleComment: '太短',
    momentInsight: '也太短',
  })), null);
  assert.equal(parseOwnerArticleDrafts(JSON.stringify({
    articleComment: '这是一段足够长度的文章留言，用于检验两段文案不能完全重复，否则就不像真实阅读后的两次表达。',
    momentInsight: '这是一段足够长度的文章留言，用于检验两段文案不能完全重复，否则就不像真实阅读后的两次表达。',
  })), null);
}

{
  const directory = await mkdtemp(join(tmpdir(), 'aipro-owner-article-failure-'));
  try {
    const state = new AgentState(join(directory, 'state.sqlite'));
    let shares = 0;
    const worker = new WeChatOwnerArticleSyndication({
      state,
      readPage: async () => { throw new Error('page unavailable'); },
      generate: async () => { throw new Error('must not generate'); },
      commentArticle: async () => { throw new Error('must not comment'); },
      publishLinkMoment: async () => { shares += 1; },
    });
    const result = await worker.observe({
      senderOpenId: 'wechat:gh_63f557f95450',
      linkCandidate: {
        url: 'https://mp.weixin.qq.com/s?__biz=MzFailure&mid=1&idx=1&sn=readfailure',
        publisherId: 'gh_63f557f95450',
      },
    });
    assert.equal(result.eligible, true);
    assert.equal(result.status, 'retry');
    assert.equal(shares, 0);
    state.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

{
  const directory = await mkdtemp(join(tmpdir(), 'aipro-owner-article-thumb-'));
  try {
    const state = new AgentState(join(directory, 'state.sqlite'));
    const shares = [];
    const worker = new WeChatOwnerArticleSyndication({
      state,
      readPage: async () => ({
        title: '流程管理者做 AI 变革，起点不是技术',
        text: '这是一篇足够长的公开文章正文，用于检验精确公众号身份能够补齐封面图，并且明确失败不会被误判为已发布。内容还需继续增加一些字符。',
      }),
      generate: async () => JSON.stringify({
        articleComment: '先识别业务判断和责任断点，再让 AI 进入流程，这个顺序能避免把旧问题只是换一层新界面。',
        momentInsight: '很多 AI 项目像先买了高性能发动机，却没有重新设计道路和交通规则。流程管理者真正要做的，是把人和 AI 的判断、执行与责任边界重新画清楚。',
      }),
      commentArticle: async () => ({ submitted: true }),
      resolveThumbUrl: async article => {
        assert.equal(article.publisherId, 'gh_07e3d1422f5e');
        return 'https://wx.qlogo.cn/public-account/132';
      },
      publishLinkMoment: async input => {
        shares.push(input);
        throw new Error('GeWe API failed (HTTP 200, ret 500): 链接朋友圈发送失败');
      },
    });
    const result = await worker.observe({
      senderOpenId: 'wechat:gh_07e3d1422f5e',
      linkCandidate: {
        url: 'https://mp.weixin.qq.com/s?__biz=MzThumb&mid=2&idx=1&sn=thumbfailure',
        title: '流程管理者做 AI 变革，起点不是技术',
      },
    });
    assert.equal(result.shared, false);
    assert.equal(shares[0].thumbUrl, 'https://wx.qlogo.cn/public-account/132');
    const persisted = state.get('wechat-owner-article-syndication', 'worker', {});
    assert.equal(persisted.articles[0].shareStatus, 'pending');
    const mutation = state.db.prepare(`SELECT status FROM mutation_execution
      WHERE execution_key LIKE '%:moment'`).get();
    assert.equal(mutation.status, 'failed_safe');
    state.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

console.log('WECHAT_OWNER_ARTICLE_SYNDICATION_TEST_OK');
