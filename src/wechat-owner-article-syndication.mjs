import { createHash } from 'node:crypto';
import { executeMutationOnce, MutationOutcomeAmbiguousError } from './mutation-execution.mjs';
import { protectedKnowledgeLeak } from './privacy-boundary.mjs';
import { eligibleOwnerArticle } from './wechat-owner-article-policy.mjs';

const STATE_SCOPE = 'wechat-owner-article-syndication';
const STATE_KEY = 'worker';
const RETRY_DELAY_MS = 5 * 60_000;
const RETENTION_MS = 180 * 24 * 60 * 60_000;

function boundedText(value, maxLength = 500) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength);
}

function parsedJson(value) {
  try {
    const parsed = JSON.parse(String(value || '').trim());
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizedComparable(value) {
  return boundedText(value, 500).toLowerCase().replace(/[\s，。！？；：、,.!?;:'"“”‘’（）()【】\[\]]+/g, '');
}

export function parseOwnerArticleDrafts(value) {
  const parsed = parsedJson(value);
  const articleComment = boundedText(parsed?.articleComment, 140);
  const momentInsight = boundedText(parsed?.momentInsight, 220);
  if (articleComment.length < 40 || articleComment.length > 120
    || momentInsight.length < 70 || momentInsight.length > 180) return null;
  if (protectedKnowledgeLeak(articleComment) || protectedKnowledgeLeak(momentInsight)) return null;
  const commentComparable = normalizedComparable(articleComment);
  const momentComparable = normalizedComparable(momentInsight);
  if (!commentComparable || !momentComparable
    || commentComparable === momentComparable
    || commentComparable.includes(momentComparable)
    || momentComparable.includes(commentComparable)) return null;
  return { articleComment, momentInsight };
}

function articleHash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 24);
}

function safeInteger(value) {
  const number = Number(value || 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function normalizedArticle(value, nowMs) {
  const articleKey = boundedText(value?.articleKey, 64);
  if (!articleKey) return null;
  const detectedAtMs = safeInteger(value?.detectedAtMs) || nowMs;
  if (detectedAtMs < nowMs - RETENTION_MS) return null;
  const status = input => ['pending', 'succeeded', 'uncertain'].includes(input) ? input : 'pending';
  return {
    articleKey,
    url: boundedText(value?.url, 4_000),
    title: boundedText(value?.title, 200),
    description: boundedText(value?.description, 500),
    publisherId: boundedText(value?.publisherId, 256),
    publisherName: boundedText(value?.publisherName, 200),
    thumbUrl: boundedText(value?.thumbUrl, 4_000),
    detectedAtMs,
    updatedAtMs: safeInteger(value?.updatedAtMs) || detectedAtMs,
    attempts: Math.min(20, safeInteger(value?.attempts)),
    nextAttemptAtMs: safeInteger(value?.nextAttemptAtMs),
    articleComment: boundedText(value?.articleComment, 120),
    momentInsight: boundedText(value?.momentInsight, 180),
    commentStatus: status(value?.commentStatus),
    shareStatus: status(value?.shareStatus),
    ...(value?.momentId ? { momentId: boundedText(value.momentId, 64) } : {}),
    ...(value?.lastError ? { lastError: boundedText(value.lastError, 160) } : {}),
  };
}

function normalizedState(value, nowMs) {
  const articles = (Array.isArray(value?.articles) ? value.articles : [])
    .map(item => normalizedArticle(item, nowMs))
    .filter(Boolean)
    .slice(-300);
  return { version: 1, articles };
}

function generationPrompt(article, page) {
  return `你是詹老师的助理。请认真阅读下面这篇公开文章，生成两段互不重复的中文表达。

要求：
1. articleComment：40–120 字，用于文章底部留言。必须针对文章核心观点作真实补充，不写“学习了”“受益匪浅”等空话。
2. momentInsight：70–180 字，用于转发朋友圈。给出一个独立判断、反常识观察或具体类比，不得复述 articleComment。
3. 只能依据文章公开正文，不得提及本地知识库、聊天、客户、项目、群名、联系方式或内部信息。
4. 不得大段照抄正文，不得营销化，不得假装是文章作者本人。
5. 只输出严格 JSON：{"articleComment":"...","momentInsight":"..."}。

<untrusted_public_article>
标题：${boundedText(page?.title || article.title, 200)}
${boundedText(page?.text, 30_000)}
</untrusted_public_article>`;
}

function errorCode(error) {
  return boundedText(error?.code || error?.message || error?.name || 'unknown_error', 160);
}

function definitelyNotApplied(error) {
  return ['COMMENT_CONFIRMATION_REQUIRED', 'ARTICLE_COMMENT_UNAVAILABLE', 'VALIDATION_ERROR']
    .includes(String(error?.code || ''));
}

export class WeChatOwnerArticleSyndication {
  constructor({
    state,
    readPage,
    generate,
    commentArticle,
    publishLinkMoment,
    publisherIds,
    ownerWechatIds,
    intervalMs = 60_000,
    now = Date.now,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  } = {}) {
    if (!state || typeof readPage !== 'function' || typeof generate !== 'function'
      || typeof commentArticle !== 'function' || typeof publishLinkMoment !== 'function') {
      throw new Error('Owner article syndication requires state, page reader, generator, commenter, and Moments publisher');
    }
    this.state = state;
    this.readPage = readPage;
    this.generate = generate;
    this.commentArticle = commentArticle;
    this.publishLinkMoment = publishLinkMoment;
    this.publisherIds = publisherIds;
    this.ownerWechatIds = ownerWechatIds;
    this.intervalMs = Math.max(60_000, Math.min(15 * 60_000, Number(intervalMs) || 60_000));
    this.now = now;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.tail = Promise.resolve();
    this.timer = null;
  }

  readState() {
    return normalizedState(this.state.get(STATE_SCOPE, STATE_KEY, null), this.now());
  }

  writeState(value) {
    const normalized = normalizedState(value, this.now());
    this.state.set(STATE_SCOPE, STATE_KEY, normalized);
    return normalized;
  }

  audit(event, article, detail = {}) {
    this.state.audit(event, {
      detail: {
        articleHash: articleHash(article?.articleKey),
        ...detail,
      },
    });
  }

  async runProcess(articleKey) {
    let current = this.readState();
    let index = current.articles.findIndex(item => item.articleKey === articleKey);
    if (index < 0) return { eligible: false, status: 'missing' };
    let article = current.articles[index];
    if (article.commentStatus === 'succeeded' && article.shareStatus === 'succeeded') {
      return { eligible: true, replayed: true, commented: true, shared: true };
    }

    if (!article.articleComment || !article.momentInsight) {
      try {
        const page = await this.readPage(article.url);
        if (!boundedText(page?.text, 30_000) || boundedText(page?.text, 30_000).length < 60) {
          throw new Error('article_text_unavailable');
        }
        const generated = await this.generate(generationPrompt(article, page));
        const drafts = parseOwnerArticleDrafts(generated);
        if (!drafts) throw new Error('generated_content_rejected');
        article.articleComment = drafts.articleComment;
        article.momentInsight = drafts.momentInsight;
        article.title = boundedText(page?.title || article.title, 200);
        article.updatedAtMs = this.now();
        delete article.lastError;
        current = this.writeState(current);
        index = current.articles.findIndex(item => item.articleKey === articleKey);
        article = current.articles[index];
        this.audit('wechat_owner_article_drafts_generated', article);
      } catch (error) {
        article.attempts += 1;
        article.nextAttemptAtMs = this.now() + RETRY_DELAY_MS;
        article.updatedAtMs = this.now();
        article.lastError = errorCode(error);
        this.writeState(current);
        this.audit('wechat_owner_article_generation_retry', article, { error: errorCode(error) });
        return { eligible: true, status: 'retry', commented: false, shared: false };
      }
    }

    let commented = article.commentStatus === 'succeeded';
    let shared = article.shareStatus === 'succeeded';
    if (!commented && article.commentStatus !== 'uncertain') {
      try {
        await executeMutationOnce({
          state: this.state,
          executionKey: `wechat-owner-article:${article.articleKey}:comment`,
          kind: 'wechat_public_article_comment',
          operation: () => this.commentArticle({
            articleKey: article.articleKey,
            url: article.url,
            title: article.title,
            content: article.articleComment,
          }),
          definitelyNotApplied,
        });
        article.commentStatus = 'succeeded';
        commented = true;
        this.audit('wechat_owner_article_comment_sent', article);
      } catch (error) {
        article.commentStatus = error instanceof MutationOutcomeAmbiguousError ? 'uncertain' : 'pending';
        article.lastError = errorCode(error);
        article.nextAttemptAtMs = this.now() + RETRY_DELAY_MS;
        this.audit('wechat_owner_article_comment_deferred', article, { error: errorCode(error) });
      }
      article.updatedAtMs = this.now();
      current.articles[index] = article;
      current = this.writeState(current);
      index = current.articles.findIndex(item => item.articleKey === articleKey);
      article = current.articles[index];
    }

    if (!shared && article.shareStatus !== 'uncertain') {
      try {
        const execution = await executeMutationOnce({
          state: this.state,
          executionKey: `wechat-owner-article:${article.articleKey}:moment`,
          kind: 'wechat_moments_link_post',
          operation: () => this.publishLinkMoment({
            content: article.momentInsight,
            title: article.title,
            description: article.description,
            linkUrl: article.url,
            thumbUrl: article.thumbUrl,
          }),
        });
        article.shareStatus = 'succeeded';
        article.momentId = boundedText(execution?.result?.data?.id, 64);
        shared = true;
        this.audit('wechat_owner_article_moment_sent', article);
      } catch (error) {
        article.shareStatus = error instanceof MutationOutcomeAmbiguousError ? 'uncertain' : 'pending';
        article.lastError = errorCode(error);
        article.nextAttemptAtMs = this.now() + RETRY_DELAY_MS;
        this.audit('wechat_owner_article_moment_deferred', article, { error: errorCode(error) });
      }
      article.updatedAtMs = this.now();
      current.articles[index] = article;
      this.writeState(current);
    }
    return {
      eligible: true,
      status: commented && shared ? 'succeeded' : 'partial',
      commented,
      shared,
    };
  }

  process(articleKey) {
    const operation = this.tail.then(() => this.runProcess(articleKey));
    this.tail = operation.catch(() => {});
    return operation;
  }

  async observe({ senderOpenId = '', linkCandidate = null, messageId = '' } = {}) {
    const eligibility = eligibleOwnerArticle({
      senderOpenId,
      linkCandidate,
      ...(this.publisherIds ? { publisherIds: this.publisherIds } : {}),
      ...(this.ownerWechatIds ? { ownerWechatIds: this.ownerWechatIds } : {}),
    });
    if (!eligibility.eligible) return eligibility;
    const { article } = eligibility;
    const current = this.readState();
    const existing = current.articles.find(item => item.articleKey === article.key);
    if (existing?.commentStatus === 'succeeded' && existing?.shareStatus === 'succeeded') {
      return { eligible: true, replayed: true, commented: true, shared: true };
    }
    if (!existing) {
      const detectedAtMs = this.now();
      current.articles.push({
        articleKey: article.key,
        url: article.url,
        title: article.title,
        description: article.description,
        publisherId: article.publisherId,
        publisherName: article.publisherName,
        thumbUrl: article.thumbUrl || '',
        detectedAtMs,
        updatedAtMs: detectedAtMs,
        attempts: 0,
        nextAttemptAtMs: 0,
        commentStatus: 'pending',
        shareStatus: 'pending',
      });
      this.writeState(current);
      this.audit('wechat_owner_article_detected', article, {
        source: eligibility.source,
        messageHash: articleHash(messageId),
      });
    }
    return this.process(article.key);
  }

  async runTick() {
    const nowMs = this.now();
    const due = this.readState().articles
      .filter(article => article.nextAttemptAtMs <= nowMs
        && (article.commentStatus === 'pending' || article.shareStatus === 'pending'))
      .map(article => article.articleKey);
    for (const articleKey of due) await this.process(articleKey);
    return due.length;
  }

  async start() {
    if (this.timer) return false;
    this.timer = this.setIntervalImpl(() => {
      this.runTick().catch(error => {
        this.state.audit('wechat_owner_article_tick_failed', {
          detail: { error: errorCode(error) },
        });
      });
    }, this.intervalMs);
    await this.runTick();
    return true;
  }

  stop() {
    if (!this.timer) return false;
    this.clearIntervalImpl(this.timer);
    this.timer = null;
    return true;
  }
}
