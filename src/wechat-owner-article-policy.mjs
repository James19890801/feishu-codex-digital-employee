import { createHash } from 'node:crypto';

export const OWNER_ARTICLE_PUBLISHER_IDS = Object.freeze([
  'gh_07e3d1422f5e',
  'BPM321GO',
  'gh_63f557f95450',
  'HuaYu_Consulting_21',
]);

export const OWNER_ARTICLE_WECHAT_IDS = Object.freeze(['fung5115']);

function boundedText(value, maxLength) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLength);
}

function normalizedSender(value) {
  return boundedText(value, 512).replace(/^wechat:/, '');
}

export function canonicalWechatArticle(linkCandidate) {
  const rawUrl = boundedText(linkCandidate?.url, 4_000);
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.hostname.toLowerCase() !== 'mp.weixin.qq.com'
    || !/^\/s(?:\/|$)/.test(parsed.pathname)) return null;
  const biz = boundedText(parsed.searchParams.get('__biz'), 256);
  const mid = boundedText(parsed.searchParams.get('mid'), 64);
  const idx = boundedText(parsed.searchParams.get('idx') || '1', 16);
  const sn = boundedText(parsed.searchParams.get('sn'), 128);
  if (!biz || !mid || !sn || !/^\d+$/.test(mid) || !/^\d+$/.test(idx)) return null;
  const canonicalUrl = new URL('https://mp.weixin.qq.com/s');
  canonicalUrl.searchParams.set('__biz', biz);
  canonicalUrl.searchParams.set('mid', mid);
  canonicalUrl.searchParams.set('idx', idx);
  canonicalUrl.searchParams.set('sn', sn);
  const identity = `${biz}\0${mid}\0${idx}\0${sn}`;
  const key = createHash('sha256').update(identity).digest('hex').slice(0, 24);
  const rawThumbUrl = boundedText(linkCandidate?.thumbUrl, 4_000);
  const thumbUrl = /^https:\/\//i.test(rawThumbUrl) ? rawThumbUrl : '';
  return {
    key,
    url: canonicalUrl.href,
    title: boundedText(linkCandidate?.title, 200),
    description: boundedText(linkCandidate?.description, 500),
    publisherId: boundedText(linkCandidate?.publisherId, 256),
    publisherName: boundedText(linkCandidate?.publisherName, 200),
    ...(thumbUrl ? { thumbUrl } : {}),
  };
}

export function eligibleOwnerArticle({
  senderOpenId = '',
  linkCandidate = null,
  publisherIds = OWNER_ARTICLE_PUBLISHER_IDS,
  ownerWechatIds = OWNER_ARTICLE_WECHAT_IDS,
} = {}) {
  const article = canonicalWechatArticle(linkCandidate);
  if (!article) return { eligible: false, reason: 'not_wechat_article' };
  const senderId = normalizedSender(senderOpenId);
  const exactPublishers = new Set(publisherIds.map(value => boundedText(value, 256)).filter(Boolean));
  const exactOwners = new Set(ownerWechatIds.map(value => boundedText(value, 256)).filter(Boolean));
  const publisherVerified = exactPublishers.has(article.publisherId);
  const directPublisher = exactPublishers.has(senderId);
  if (!publisherVerified && !directPublisher) {
    return { eligible: false, reason: 'unverified_publisher' };
  }
  const verifiedArticle = directPublisher && !article.publisherId
    ? { ...article, publisherId: senderId }
    : article;
  return {
    eligible: true,
    article: verifiedArticle,
    source: directPublisher ? 'publisher_callback' : exactOwners.has(senderId) ? 'owner_share' : 'verified_share',
  };
}
