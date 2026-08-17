import assert from 'node:assert/strict';
import {
  canonicalWechatArticle,
  eligibleOwnerArticle,
} from './wechat-owner-article-policy.mjs';

const canonical = canonicalWechatArticle({
  url: 'http://mp.weixin.qq.com/s?__biz=MzkxMTczNzkyMA==&mid=2247488166&idx=1&sn=bdd47a6f9cf63f43783fbac863076c90&scene=0&xtrack=1#rd',
  title: '流程管理者做 AI 变革，起点不是技术',
  description: '真正的起点是业务问题。',
  publisherId: 'gh_07e3d1422f5e',
  publisherName: '詹生talk',
  thumbUrl: 'https://mmbiz.qpic.cn/example/640',
});
assert.equal(canonical.url, 'https://mp.weixin.qq.com/s?__biz=MzkxMTczNzkyMA%3D%3D&mid=2247488166&idx=1&sn=bdd47a6f9cf63f43783fbac863076c90');
assert.equal(canonical.title, '流程管理者做 AI 变革，起点不是技术');
assert.equal(canonical.publisherId, 'gh_07e3d1422f5e');
assert.match(canonical.key, /^[a-f0-9]{24}$/);

const duplicateShare = canonicalWechatArticle({
  url: 'https://mp.weixin.qq.com/s?sn=bdd47a6f9cf63f43783fbac863076c90&idx=1&mid=2247488166&__biz=MzkxMTczNzkyMA==&mpshare=1&scene=1&srcid=noise#rd',
  title: '同一篇文章的群分享',
});
assert.equal(duplicateShare.key, canonical.key);
assert.equal(duplicateShare.url, canonical.url);

const directPublisher = eligibleOwnerArticle({
  senderOpenId: 'wechat:gh_07e3d1422f5e',
  linkCandidate: { ...canonical, publisherId: '' },
});
assert.equal(directPublisher.eligible, true);
assert.equal(directPublisher.article.publisherId, 'gh_07e3d1422f5e');

assert.equal(eligibleOwnerArticle({
  senderOpenId: 'wechat:fung5115',
  linkCandidate: canonical,
}).eligible, true);

for (const publisherId of [
  'gh_07e3d1422f5e',
  'BPM321GO',
  'gh_63f557f95450',
  'HuaYu_Consulting_21',
]) {
  assert.equal(eligibleOwnerArticle({
    senderOpenId: `wechat:${publisherId}`,
    linkCandidate: { ...canonical, publisherId },
  }).eligible, true, `${publisherId} must be an exact eligible publisher`);
}

assert.deepEqual(eligibleOwnerArticle({
  senderOpenId: 'wechat:fung5115',
  linkCandidate: {
    ...canonical,
    publisherId: '',
  },
}), { eligible: false, reason: 'unverified_publisher' });

assert.deepEqual(eligibleOwnerArticle({
  senderOpenId: 'wechat:someone_else',
  linkCandidate: {
    ...canonical,
    publisherId: 'gh_lookalike',
    publisherName: '詹生talk',
  },
}), { eligible: false, reason: 'unverified_publisher' });

assert.deepEqual(eligibleOwnerArticle({
  senderOpenId: 'wechat:gh_07e3d1422f5e',
  linkCandidate: { url: 'https://example.com/article', title: '外部文章' },
}), { eligible: false, reason: 'not_wechat_article' });

assert.equal(canonicalWechatArticle({ url: 'javascript:alert(1)' }), null);
assert.equal(canonicalWechatArticle({ url: 'https://mp.weixin.qq.com/s?mid=1' }), null);

console.log('WECHAT_OWNER_ARTICLE_POLICY_TEST_OK');
