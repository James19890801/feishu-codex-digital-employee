import { createHash } from 'node:crypto';

const MAX_EVENT_TEXT = 4_000;
const MAX_FACT_TEXT = 240;
const MIN_FACT_CONFIDENCE = 0.75;
const SENSITIVE = /(?:验证码|一次性口令|密码|私钥|secret|access[_ -]?token|身份证|银行卡|账户余额|诊断|处方|用药|政治立场|宗教信仰|心理疾病)/iu;

function clean(value, limit = 1_000) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, limit);
}

function hash(value, length = 32) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, length);
}

function timestamp(value, fallback = Date.now()) {
  const numeric = String(value ?? '').trim() ? Number(value) : Number.NaN;
  const source = Number.isFinite(numeric)
    ? (numeric < 10_000_000_000 ? numeric * 1_000 : numeric)
    : value || fallback;
  const date = new Date(source);
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(fallback).toISOString();
}

function boundedList(value, limit = 12, itemLength = 120) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map(item => clean(item, itemLength)).filter(Boolean))].slice(0, limit);
}

export function canonicalWeChatPersonId(value) {
  const raw = clean(value, 500).replace(/^wechat:/, '');
  if (!raw || raw.endsWith('@chatroom') || raw === 'system' || /\s/.test(raw)) return '';
  return `wechat:${raw}`;
}

function chatroomId(contextId) {
  return clean(contextId, 500).replace(/^wechat:group:/, '');
}

export function relationshipAudience({ surface, personId = '', contextId = '' } = {}) {
  if (surface === 'moments') return 'public_moments';
  if (surface === 'group') {
    const room = chatroomId(contextId);
    return room && room.endsWith('@chatroom') ? `group:${room}` : '';
  }
  if (surface === 'p2p') {
    const person = canonicalWeChatPersonId(personId);
    return person ? `private:${person}` : '';
  }
  return '';
}

function derivedAudience(sourceEpisodes) {
  const scopes = [...new Set(sourceEpisodes.map(item => item.audienceScope).filter(Boolean))];
  const privateScope = scopes.find(scope => scope.startsWith('private:'));
  if (privateScope) return privateScope;
  const groups = scopes.filter(scope => scope.startsWith('group:'));
  if (groups.length === 1 && scopes.every(scope => scope === groups[0] || scope === 'public_moments')) {
    return groups[0];
  }
  if (groups.length > 0) return 'owner_only';
  return scopes.length === 1 && scopes[0] === 'public_moments' ? 'public_moments' : 'owner_only';
}

export function parseRelationshipReflection(output, { episodes = [] } = {}) {
  const source = String(output || '').trim();
  if (!source.startsWith('{') || !source.endsWith('}') || source.includes('```')) {
    throw new Error('Relationship reflection must be strict JSON');
  }
  let parsed;
  try { parsed = JSON.parse(source); } catch {
    throw new Error('Relationship reflection JSON is invalid');
  }
  const evidence = new Map((Array.isArray(episodes) ? episodes : [])
    .map(item => [String(item.eventId || ''), item]));
  const facts = (Array.isArray(parsed?.facts) ? parsed.facts : []).slice(0, 12).map(item => {
    const kind = clean(item?.kind, 80);
    const content = clean(item?.content, MAX_FACT_TEXT);
    const confidence = Number(item?.confidence || 0);
    const sourceEventIds = boundedList(item?.sourceEventIds, 8, 500);
    if (!/^[a-z][a-z0-9_.-]{2,79}$/.test(kind) || content.length < 4
      || !Number.isFinite(confidence) || confidence < MIN_FACT_CONFIDENCE || confidence > 1) {
      throw new Error('Relationship fact schema is invalid');
    }
    if (SENSITIVE.test(content)) throw new Error('Relationship fact contains sensitive content');
    if (!sourceEventIds.length || sourceEventIds.some(id => !evidence.has(id))) {
      throw new Error('Relationship fact evidence is missing');
    }
    const sourceEpisodes = sourceEventIds.map(id => evidence.get(id));
    if (!sourceEpisodes.some(event => event.direction === 'inbound')) {
      throw new Error('Relationship fact evidence requires an inbound event');
    }
    return {
      kind, content, confidence, sourceEventIds,
      audienceScope: derivedAudience(sourceEpisodes),
    };
  });
  const rawProfile = parsed?.profile && typeof parsed.profile === 'object' ? parsed.profile : {};
  const profile = {
    familiarity: ['new', 'acquainted', 'familiar', 'close']
      .includes(rawProfile.familiarity) ? rawProfile.familiarity : 'new',
    tone: clean(rawProfile.tone, 200),
    topics: boundedList(rawProfile.topics, 12, 100),
    openLoops: boundedList(rawProfile.openLoops, 12, 160),
    summary: clean(rawProfile.summary, 600),
    confidence: Math.max(0, Math.min(1, Number(rawProfile.confidence) || 0)),
  };
  if (SENSITIVE.test([profile.tone, profile.topics, profile.openLoops, profile.summary].flat().join('\n'))) {
    throw new Error('Relationship profile contains sensitive content');
  }
  return { facts, profile };
}

function eventImportance(text, direction) {
  const value = clean(text, MAX_EVENT_TEXT);
  let score = direction === 'inbound' ? 0.55 : 0.4;
  if (/(?:记得|提醒|下周|明天|以后|计划|答应|约|喜欢|不喜欢|负责|从事|我是)/.test(value)) score += 0.2;
  if ([...value].length > 80) score += 0.1;
  return Math.min(1, score);
}

function surfaceForChatType(chatType) {
  return chatType === 'group' ? 'group' : chatType === 'p2p' ? 'p2p' : '';
}

function relevance(text, query) {
  const normalizedText = clean(text, 4_000).toLowerCase().replace(/\s+/g, '');
  const normalizedQuery = clean(query, 1_000).toLowerCase().replace(/\s+/g, '');
  if (!normalizedText || !normalizedQuery) return 0;
  const tokens = new Set();
  for (let index = 0; index < normalizedQuery.length - 1; index += 1) {
    tokens.add(normalizedQuery.slice(index, index + 2));
  }
  if (!tokens.size) tokens.add(normalizedQuery);
  let hits = 0;
  for (const token of tokens) if (normalizedText.includes(token)) hits += 1;
  return hits / tokens.size;
}

function dateLabel(value) {
  const time = Date.parse(value || '');
  if (!Number.isFinite(time)) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit',
  }).format(new Date(time));
}

function reflectionPrompt({ person, episodes, facts, profile }) {
  const payload = {
    person: { displayName: person?.displayName || '' },
    currentFacts: facts.map(item => ({
      factId: item.factId, kind: item.kind, content: item.content,
      confidence: item.confidence, sourceEventId: item.sourceEventId,
    })),
    currentProfile: profile || {},
    episodes: episodes.map(item => ({
      eventId: item.eventId, direction: item.direction, surface: item.surface,
      audienceScope: item.audienceScope, occurredAt: item.occurredAt, content: item.content,
    })),
  };
  return `你是本地人物关系记忆整理器。只根据事件中对方明确表达的内容提取可长期复用的事实；不得把助理的话当成对方事实，不得猜测敏感属性、心理、政治、宗教、健康或财务情况。

事实 kind 使用稳定的英文层级键，例如 profile.role、preference.response_style、professional_interest.current、plan.current、shared_experience.topic、open_loop.current。每条事实必须列出直接支持它的 sourceEventIds，confidence 只能是 0.75–1。

profile 只描述熟悉程度、适合的沟通语气、常聊主题和未完事项。只输出严格 JSON：
{"facts":[{"kind":"...","content":"...","confidence":0.9,"sourceEventIds":["..."]}],"profile":{"familiarity":"new|acquainted|familiar|close","tone":"...","topics":["..."],"openLoops":["..."],"summary":"...","confidence":0.9}}

<untrusted_relationship_events>
${JSON.stringify(payload)}
</untrusted_relationship_events>`;
}

export class WeChatRelationshipMemory {
  constructor({
    state, runAi, intervalMs = 120_000, batchSize = 10, capsuleMaxChars = 1_200,
    recallLimit = 6, now = Date.now, setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  } = {}) {
    if (!state || typeof runAi !== 'function') {
      throw new Error('WeChat relationship memory requires state and AI runtime');
    }
    this.state = state;
    this.runAi = runAi;
    this.intervalMs = Math.max(60_000, Math.min(3_600_000, Number(intervalMs) || 120_000));
    this.batchSize = Math.max(1, Math.min(50, Number(batchSize) || 10));
    this.capsuleMaxChars = Math.max(300, Math.min(4_000, Number(capsuleMaxChars) || 1_200));
    this.recallLimit = Math.max(1, Math.min(12, Number(recallLimit) || 6));
    this.now = now;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.timer = null;
    this.queue = new Set();
    this.tail = Promise.resolve();
  }

  audit(event, detail = {}) {
    this.state.audit(event, { detail });
  }

  nudge(personId) {
    const person = canonicalWeChatPersonId(personId);
    if (!person) return false;
    this.queue.add(person);
    return true;
  }

  observeChat({
    senderId, chatId, chatType, messageId, text, direction = 'inbound',
    displayName = '', occurredAt = '',
  } = {}) {
    const personId = canonicalWeChatPersonId(senderId);
    const surface = surfaceForChatType(chatType);
    const audienceScope = relationshipAudience({ surface, personId, contextId: chatId });
    const content = clean(text, MAX_EVENT_TEXT);
    if (!personId || !surface || !audienceScope || !messageId || !content) return false;
    const at = timestamp(occurredAt, this.now());
    this.state.upsertRelationshipPerson({
      personId, channel: 'wechat', externalId: personId.slice('wechat:'.length),
      displayName: clean(displayName, 200), firstSeenAt: at, lastSeenAt: at,
    });
    const inserted = this.state.recordRelationshipEpisode({
      eventId: clean(messageId, 500), personId, channel: 'wechat', surface,
      contextId: clean(chatId, 500), audienceScope,
      direction: direction === 'outbound' ? 'outbound' : 'inbound', content,
      sourceRef: clean(messageId, 500), occurredAt: at,
      importance: eventImportance(content, direction),
    });
    if (inserted) {
      this.nudge(personId);
      this.audit('wechat_relationship_episode_recorded', {
        personHash: hash(personId, 24), eventHash: hash(messageId, 24), surface,
      });
    }
    return inserted;
  }

  observeMoment(moment = {}) {
    const momentId = clean(moment.id, 64);
    const author = canonicalWeChatPersonId(moment.userName);
    if (!momentId || !author) return 0;
    let inserted = 0;
    const postAt = timestamp(moment.createTimeMs, this.now());
    this.state.upsertRelationshipPerson({
      personId: author, channel: 'wechat', externalId: author.slice(7),
      displayName: clean(moment.nickName, 200), firstSeenAt: postAt, lastSeenAt: postAt,
    });
    if (clean(moment.content, MAX_EVENT_TEXT)) {
      const eventId = `wechat-moment:${momentId}:post:${author.slice(7)}`;
      if (this.state.recordRelationshipEpisode({
        eventId, personId: author, channel: 'wechat', surface: 'moments',
        contextId: momentId, audienceScope: 'public_moments', direction: 'inbound',
        content: clean(moment.content, MAX_EVENT_TEXT), sourceRef: momentId,
        occurredAt: postAt, importance: 0.6,
      })) {
        inserted += 1;
        this.nudge(author);
      }
    }
    for (const comment of (Array.isArray(moment.comments) ? moment.comments : []).slice(0, 500)) {
      const personId = canonicalWeChatPersonId(comment.userName);
      const commentId = String(comment.commentId || '').trim();
      const content = clean(comment.content, 500);
      if (!personId || !commentId || !content) continue;
      const at = timestamp(comment.createTimeMs, this.now());
      this.state.upsertRelationshipPerson({
        personId, channel: 'wechat', externalId: personId.slice(7),
        displayName: clean(comment.nickName, 200), firstSeenAt: at, lastSeenAt: at,
      });
      const eventId = `wechat-moment:${momentId}:comment:${commentId}:${personId.slice(7)}`;
      if (this.state.recordRelationshipEpisode({
        eventId, personId, channel: 'wechat', surface: 'moments', contextId: momentId,
        audienceScope: 'public_moments', direction: 'inbound', content,
        sourceRef: `${momentId}:${commentId}`, occurredAt: at, importance: 0.65,
      })) {
        inserted += 1;
        this.nudge(personId);
      }
    }
    if (inserted) this.audit('wechat_relationship_moments_observed', {
      momentHash: hash(momentId, 24), inserted,
    });
    return inserted;
  }

  observeOutbound({
    personId = '', wxid = '', eventId, surface, contextId, content, occurredAt = '',
  } = {}) {
    const person = canonicalWeChatPersonId(personId || wxid);
    const audienceScope = relationshipAudience({ surface, personId: person, contextId });
    const text = clean(content, MAX_EVENT_TEXT);
    if (!person || !audienceScope || !eventId || !text) return false;
    const at = timestamp(occurredAt, this.now());
    this.state.upsertRelationshipPerson({
      personId: person, channel: 'wechat', externalId: person.slice(7),
      firstSeenAt: at, lastSeenAt: at,
    });
    const inserted = this.state.recordRelationshipEpisode({
      eventId: clean(eventId, 500), personId: person, channel: 'wechat', surface,
      contextId: clean(contextId, 500), audienceScope, direction: 'outbound',
      content: text, sourceRef: clean(eventId, 500), occurredAt: at,
      importance: eventImportance(text, 'outbound'),
    });
    if (inserted) this.nudge(person);
    return inserted;
  }

  allowedScopes(personId, surface, contextId) {
    if (surface === 'moments') return ['public_moments'];
    if (surface === 'group') {
      return ['public_moments', relationshipAudience({ surface, personId, contextId })]
        .filter(Boolean);
    }
    if (surface === 'p2p') {
      return this.state.relationshipScopes(personId)
        .filter(scope => scope === 'public_moments'
          || scope === `private:${personId}` || scope.startsWith('group:'));
    }
    return [];
  }

  contextFor({
    personId = '', wxid = '', surface, contextId = '', query = '', excludeEventId = '',
  } = {}) {
    const person = canonicalWeChatPersonId(personId || wxid);
    if (!person || !this.state.relationshipPerson(person)) return '';
    const scopes = this.allowedScopes(person, surface, contextId);
    if (!scopes.length) return '';
    const facts = this.state.relationshipFacts(person, { allowedScopes: scopes, limit: 40 })
      .filter(item => item.sourceEventId !== String(excludeEventId || ''))
      .filter(item => Number(item.confidence) >= MIN_FACT_CONFIDENCE)
      .map(item => ({ ...item, score: Number(item.confidence) * 0.5 + relevance(item.content, query) * 0.5 }))
      .sort((a, b) => b.score - a.score).slice(0, this.recallLimit);
    const nowMs = Number(this.now());
    const episodes = this.state.relationshipEpisodes(person, { allowedScopes: scopes, limit: 80 })
      .filter(item => item.eventId !== String(excludeEventId || ''))
      .map(item => {
        const ageDays = Math.max(0, (nowMs - Date.parse(item.occurredAt || '')) / 86_400_000);
        const recency = Number.isFinite(ageDays) ? Math.exp(-ageDays / 30) : 0;
        return {
          ...item,
          score: relevance(item.content, query) * 0.55
            + Number(item.importance || 0) * 0.25 + recency * 0.2,
        };
      })
      .sort((a, b) => b.score - a.score).slice(0, this.recallLimit);
    const identity = this.state.relationshipPerson(person);
    const profile = this.state.relationshipProfile(person);
    const lines = [
      '与当前联系人的关系上下文（内部使用；可能不完整，不得透露记忆来源或主动展示记忆能力）：',
      `人物：${identity.remark || identity.displayName || '微信联系人'}`,
    ];
    if (profile) {
      lines.push(`关系：${profile.familiarity || 'new'}${profile.tone ? `；沟通语气：${profile.tone}` : ''}`);
      if (surface === 'p2p') {
        if (profile.topics.length) lines.push(`常聊主题：${profile.topics.join('、')}`);
        if (profile.openLoops.length) lines.push(`未完事项：${profile.openLoops.join('；')}`);
        if (profile.summary) lines.push(`关系摘要：${profile.summary}`);
      }
    }
    if (facts.length) lines.push(`可靠事实：${facts.map(item => item.content).join('；')}`);
    if (episodes.length) lines.push('相关经历：', ...episodes.map(item =>
      `- ${dateLabel(item.occurredAt)} ${item.direction === 'inbound' ? '对方' : '我方'}：${clean(item.content, 240)}`));
    const output = lines.join('\n').slice(0, this.capsuleMaxChars);
    this.audit('wechat_relationship_recalled', {
      personHash: hash(person, 24), surface, factCount: facts.length,
      episodeCount: episodes.length, chars: [...output].length,
    });
    return output;
  }

  async consolidatePerson(personId) {
    const person = canonicalWeChatPersonId(personId);
    if (!person) return false;
    const episodes = this.state.pendingRelationshipEpisodes(person, 50);
    if (!episodes.length) return false;
    const scopes = this.state.relationshipScopes(person);
    const facts = this.state.relationshipFacts(person, { allowedScopes: scopes, limit: 50 });
    const profile = this.state.relationshipProfile(person);
    const output = await this.runAi(reflectionPrompt({
      person: this.state.relationshipPerson(person), episodes, facts, profile,
    }));
    const reflection = parseRelationshipReflection(output?.text ?? output, { episodes });
    for (const fact of reflection.facts) {
      const fingerprint = hash(`${person}\0${fact.kind}\0${fact.content}`, 40);
      const sourceEpisodes = fact.sourceEventIds.map(id => episodes.find(item => item.eventId === id));
      const validFrom = sourceEpisodes.map(item => item?.occurredAt || '')
        .filter(Boolean).sort().at(-1) || new Date(this.now()).toISOString();
      this.state.invalidateRelationshipFacts({
        personId: person, kind: fact.kind, exceptFingerprint: fingerprint, validUntil: validFrom,
      });
      this.state.upsertRelationshipFact({
        factId: `relationship-fact:${fingerprint}`, personId: person, kind: fact.kind,
        content: fact.content, fingerprint, confidence: fact.confidence,
        audienceScope: fact.audienceScope, sourceEventId: fact.sourceEventIds[0], validFrom,
      });
    }
    this.state.setRelationshipProfile(person, {
      ...reflection.profile,
      displayName: this.state.relationshipPerson(person)?.displayName || '',
    });
    this.state.markRelationshipEpisodesProcessed(episodes.map(item => item.eventId));
    this.audit('wechat_relationship_consolidated', {
      personHash: hash(person, 24), episodeCount: episodes.length,
      factCount: reflection.facts.length,
    });
    return true;
  }

  async runFlush() {
    const queued = [...this.queue];
    this.queue.clear();
    const people = (queued.length ? queued : this.state.pendingRelationshipPeople(this.batchSize)
      .map(item => item.personId)).slice(0, this.batchSize);
    let processed = 0;
    for (const personId of people) {
      try {
        if (await this.consolidatePerson(personId)) processed += 1;
      } catch (error) {
        this.audit('wechat_relationship_consolidation_failed', {
          personHash: hash(personId, 24), error: clean(error?.code || error?.name || 'error', 80),
        });
      }
    }
    return processed;
  }

  flush() {
    const operation = this.tail.then(() => this.runFlush());
    this.tail = operation.catch(() => {});
    return operation;
  }

  start() {
    if (this.timer) return false;
    this.timer = this.setIntervalImpl(() => { this.flush().catch(() => {}); }, this.intervalMs);
    this.timer?.unref?.();
    return true;
  }

  stop() {
    if (!this.timer) return false;
    this.clearIntervalImpl(this.timer);
    this.timer = null;
    return true;
  }
}
