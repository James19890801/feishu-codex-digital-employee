import { createHash } from 'node:crypto';
import {
  abstractPrivateKnowledge,
  isSafeKnowledgeEvidence,
} from './local-wiki-policy.mjs';
import {
  hasLongVerbatimOverlap,
  protectedKnowledgeLeak,
} from './privacy-boundary.mjs';
import {
  compareSemanticTopics,
  semanticTopic,
} from './semantic-repeat-guard.mjs';
import { executeMutationOnce } from './mutation-execution.mjs';

const SHANGHAI_OFFSET = '+08:00';
const STATE_SCOPE = 'wechat-moments-publisher';
const STATE_KEY = 'worker';
const RETRY_INTERVAL_MS = 5 * 60_000;
const MAX_GENERATION_ATTEMPTS = 3;
const HISTORY_RETENTION_MS = 90 * 24 * 60 * 60_000;
const TOPICS = [
  '端到端流程与局部效率',
  'AI 与流程责任边界',
  '流程 Owner 与跨部门协同',
  '例外管理与智能体',
  '流程指标与经营结果',
  '知识、决策与执行闭环',
  '流程标准化与 AI 个性化',
  '人、AI 与 AI 之间的协同',
  '流程变革与组织权责',
  '自动化与可观测性',
  '从流程图到真实运行',
  'AI 时代的管理者工作',
];

function boundedText(value, maxLength = 500) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength);
}

export function shanghaiDayKey(nowMs = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(nowMs));
}

function atShanghai(day, time) {
  return Date.parse(`${day}T${time}:00${SHANGHAI_OFFSET}`);
}

function randomMinute(startMs, endMs, random) {
  const minutes = Math.max(1, Math.floor((endMs - startMs) / 60_000));
  const unit = Math.max(0, Math.min(0.999999, Number(random()) || 0));
  return startMs + Math.floor(unit * minutes) * 60_000;
}

function slot(id, atMs, endMs) {
  return {
    id,
    atMs,
    endMs,
    status: 'pending',
    attempts: 0,
    nextAttemptAtMs: atMs,
  };
}

export function planMomentsDay({
  nowMs = Date.now(),
  activatedAtMs = 0,
  random = Math.random,
} = {}) {
  const day = shanghaiDayKey(nowMs);
  const windows = [
    { id: 'morning', startMs: atShanghai(day, '10:00'), endMs: atShanghai(day, '12:00') },
    { id: 'evening', startMs: atShanghai(day, '18:30'), endMs: atShanghai(day, '21:00') },
  ];
  if (!activatedAtMs) {
    const dayEndMs = atShanghai(day, '23:59') + 59_000;
    const remaining = [...windows].reverse().find(window => window.endMs > nowMs);
    return {
      day,
      activatedAtMs: nowMs,
      slots: [
        slot('activation', nowMs, Math.min(dayEndMs, nowMs + 60 * 60_000)),
        ...(remaining
          ? [slot(remaining.id, randomMinute(
              Math.max(remaining.startMs, nowMs + 5 * 60_000),
              remaining.endMs,
              random,
            ), remaining.endMs)]
          : []),
      ].slice(0, 2),
    };
  }
  return {
    day,
    activatedAtMs,
    slots: windows.map(window => slot(
      window.id,
      randomMinute(window.startMs, window.endMs, random),
      window.endMs,
    )),
  };
}

function parsedJson(value) {
  try {
    const parsed = JSON.parse(String(value || '').trim());
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseGeneratedMomentsPost(raw, {
  knowledge = '',
  history = [],
} = {}) {
  const parsed = parsedJson(raw);
  const topic = boundedText(parsed?.topic, 60);
  const content = boundedText(parsed?.content, 500);
  const evidence = String(knowledge || '').trim();
  if (!topic || topic.length < 2 || content.length < 100 || content.length > 220) return null;
  if (!evidence || !isSafeKnowledgeEvidence(evidence)) return null;
  if (protectedKnowledgeLeak(content)
    || hasLongVerbatimOverlap(content, [evidence], { minimumChars: 80 })) return null;
  const abstracted = abstractPrivateKnowledge(content);
  if (!abstracted.safe || abstracted.redactionCount > 0 || abstracted.text !== content) return null;
  const current = semanticTopic(content);
  const repeated = (Array.isArray(history) ? history : [])
    .some(previous => compareSemanticTopics(semanticTopic(previous), current).repeat);
  if (repeated) return null;
  return { topic, content };
}

function contentHash(value) {
  return createHash('sha256').update(String(value || '')).digest('hex').slice(0, 24);
}

function safeInteger(value) {
  const number = Number(value || 0);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function normalizedSlot(value) {
  const id = boundedText(value?.id, 30);
  const status = ['pending', 'sent', 'skipped', 'uncertain'].includes(value?.status)
    ? value.status
    : 'pending';
  return {
    id,
    atMs: safeInteger(value?.atMs),
    endMs: safeInteger(value?.endMs),
    status,
    attempts: Math.min(MAX_GENERATION_ATTEMPTS, safeInteger(value?.attempts)),
    nextAttemptAtMs: safeInteger(value?.nextAttemptAtMs),
    ...(value?.publishedAtMs ? { publishedAtMs: safeInteger(value.publishedAtMs) } : {}),
    ...(value?.momentId ? { momentId: boundedText(value.momentId, 40) } : {}),
    ...(value?.reason ? { reason: boundedText(value.reason, 80) } : {}),
  };
}

function normalizedState(value, nowMs) {
  const source = value && typeof value === 'object' ? value : {};
  const history = (Array.isArray(source.history) ? source.history : [])
    .flatMap(item => {
      const content = boundedText(item?.content, 220);
      const publishedAtMs = safeInteger(item?.publishedAtMs);
      if (!content || !publishedAtMs || publishedAtMs < nowMs - HISTORY_RETENTION_MS) return [];
      return [{
        day: boundedText(item?.day, 10),
        topic: boundedText(item?.topic, 60),
        content,
        hash: boundedText(item?.hash, 64) || contentHash(content),
        publishedAtMs,
      }];
    })
    .slice(-180);
  const plan = source.plan && typeof source.plan === 'object'
    ? {
        day: boundedText(source.plan.day, 10),
        slots: (Array.isArray(source.plan.slots) ? source.plan.slots : [])
          .map(normalizedSlot)
          .filter(item => item.id && item.atMs && item.endMs)
          .slice(0, 2),
      }
    : { day: '', slots: [] };
  return {
    version: 1,
    activatedAtMs: safeInteger(source.activatedAtMs),
    plan,
    history,
  };
}

function topicFor(day, slotId) {
  const digest = createHash('sha256').update(`${day}\0${slotId}`).digest('hex');
  return TOPICS[Number.parseInt(digest.slice(0, 8), 16) % TOPICS.length];
}

function generationPrompt({ topic, knowledge, history }) {
  const recent = history.slice(-12).map((item, index) => `${index + 1}. ${item}`).join('\n');
  return `你正在以账号本人的口吻写一条中文微信朋友圈。
主题：${topic}

要求：
1. 只谈 AI、流程管理、组织协同或经营管理的可泛化认知。
2. 100–220 个字符，有一个明确判断，再用一个具体类比或反常识观察说清楚。
3. 可以有一句克制的幽默，但不要段子化、营销化、鸡汤化。
4. 不要标题、标签、链接、号召转发或“资料显示”等来源说明。
5. 绝对不得出现真实人名、公司、客户、项目、群名、账号、联系方式、文件路径、内部数据或资料来源。
6. 不得照抄知识材料的长句，只能吸收后重新表达。
7. 与近期已发内容保持明显不同的观点和类比。
8. 仅输出严格 JSON：{"topic":"简短主题","content":"朋友圈正文"}。

${recent ? `近期已发公开内容（仅用于避免重复）：\n${recent}\n\n` : ''}<untrusted_local_knowledge>
${knowledge}
</untrusted_local_knowledge>`;
}

function errorSummary(error) {
  return boundedText(error?.code || error?.name || error?.message || 'unknown_error', 160);
}

export class WeChatMomentsPublisher {
  constructor({
    state,
    channel,
    generate,
    retrieveKnowledge,
    intervalMs = 60_000,
    now = Date.now,
    random = Math.random,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  } = {}) {
    if (!state || !channel || typeof generate !== 'function'
      || typeof retrieveKnowledge !== 'function') {
      throw new Error('WeChat Moments publisher requires state, channel, generation, and knowledge retrieval');
    }
    this.state = state;
    this.channel = channel;
    this.generate = generate;
    this.retrieveKnowledge = retrieveKnowledge;
    this.intervalMs = Math.max(60_000, Math.min(15 * 60_000, Number(intervalMs) || 60_000));
    this.now = now;
    this.random = random;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.timer = null;
    this.tail = Promise.resolve();
  }

  readState() {
    return normalizedState(this.state.get(STATE_SCOPE, STATE_KEY, null), this.now());
  }

  writeState(value) {
    const normalized = normalizedState(value, this.now());
    this.state.set(STATE_SCOPE, STATE_KEY, normalized);
    return normalized;
  }

  audit(event, detail = {}) {
    this.state.audit(event, { detail });
  }

  ensurePlan(current) {
    const nowMs = this.now();
    const today = shanghaiDayKey(nowMs);
    if (current.plan.day === today && current.plan.slots.length) return current;
    const plan = planMomentsDay({
      nowMs,
      activatedAtMs: current.activatedAtMs,
      random: this.random,
    });
    const next = this.writeState({
      ...current,
      activatedAtMs: current.activatedAtMs || plan.activatedAtMs,
      plan: { day: plan.day, slots: plan.slots },
    });
    this.audit('wechat_moments_post_plan_created', {
      day: next.plan.day,
      slots: next.plan.slots.map(item => ({ id: item.id, atMs: item.atMs })),
    });
    return next;
  }

  recordGenerationFailure(current, slotIndex, reason) {
    const nowMs = this.now();
    const target = current.plan.slots[slotIndex];
    target.attempts += 1;
    target.reason = reason;
    const nextAttemptAtMs = nowMs + RETRY_INTERVAL_MS;
    if (target.attempts >= MAX_GENERATION_ATTEMPTS || nextAttemptAtMs > target.endMs) {
      target.status = 'skipped';
    } else {
      target.nextAttemptAtMs = nextAttemptAtMs;
    }
    const next = this.writeState(current);
    this.audit('wechat_moments_post_generation_rejected', {
      day: next.plan.day,
      slot: target.id,
      attempts: target.attempts,
      reason,
      terminal: target.status === 'skipped',
    });
    return next;
  }

  async processSlot(current, slotIndex, reason) {
    const target = current.plan.slots[slotIndex];
    const topic = topicFor(current.plan.day, target.id);
    let knowledge = '';
    try {
      knowledge = await this.retrieveKnowledge(
        `如何理解 AI 与流程管理中的${topic}，有哪些可泛化的方法、机制和判断？`,
      );
    } catch (error) {
      return this.recordGenerationFailure(current, slotIndex, `knowledge_${errorSummary(error)}`);
    }
    if (!knowledge) return this.recordGenerationFailure(current, slotIndex, 'knowledge_unavailable');

    const history = current.history.map(item => item.content);
    let generated;
    try {
      generated = await this.generate(generationPrompt({ topic, knowledge, history }));
    } catch (error) {
      return this.recordGenerationFailure(current, slotIndex, `generation_${errorSummary(error)}`);
    }
    const post = parseGeneratedMomentsPost(generated, { knowledge, history });
    if (!post) return this.recordGenerationFailure(current, slotIndex, 'content_policy');

    const hash = contentHash(post.content);
    const executionKey = `wechat-moments-publisher:${current.plan.day}:${target.id}`;
    try {
      const execution = await executeMutationOnce({
        state: this.state,
        executionKey,
        kind: 'wechat_moments_text_post',
        operation: () => this.channel.publishTextMoment({ content: post.content }),
      });
      const publishedAtMs = this.now();
      const momentId = boundedText(execution?.result?.data?.id, 40);
      target.status = 'sent';
      target.publishedAtMs = publishedAtMs;
      target.momentId = momentId;
      delete target.reason;
      current.history.push({
        day: current.plan.day,
        topic: post.topic,
        content: post.content,
        hash,
        publishedAtMs,
      });
      const next = this.writeState(current);
      this.audit('wechat_moments_post_sent', {
        day: next.plan.day,
        slot: target.id,
        postHash: hash,
        momentId,
        replayed: execution.replayed === true,
        trigger: reason,
      });
      return next;
    } catch (error) {
      target.status = 'uncertain';
      target.reason = errorSummary(error);
      const next = this.writeState(current);
      this.audit('wechat_moments_post_uncertain', {
        day: next.plan.day,
        slot: target.id,
        postHash: hash,
        error: errorSummary(error),
      });
      return next;
    }
  }

  async runTick(reason) {
    const nowMs = this.now();
    let current = this.ensurePlan(this.readState());
    let changed = false;
    for (const item of current.plan.slots) {
      if (item.status === 'pending' && nowMs > item.endMs) {
        item.status = 'skipped';
        item.reason = 'window_expired';
        changed = true;
      }
    }
    if (changed) current = this.writeState(current);
    const sentCount = current.plan.slots.filter(item => item.status === 'sent').length;
    if (sentCount >= 2) return false;
    const slotIndex = current.plan.slots.findIndex(item => item.status === 'pending'
      && item.atMs <= nowMs
      && item.nextAttemptAtMs <= nowMs
      && nowMs <= item.endMs);
    if (slotIndex < 0) return false;
    await this.processSlot(current, slotIndex, reason);
    return true;
  }

  tick(reason = 'periodic') {
    const operation = this.tail.then(() => this.runTick(reason));
    this.tail = operation.catch(() => {});
    return operation;
  }

  async start() {
    if (this.timer) return false;
    this.timer = this.setIntervalImpl(() => {
      this.tick('periodic').catch(error => {
        this.audit('wechat_moments_publisher_tick_failed', { error: errorSummary(error) });
      });
    }, this.intervalMs);
    await this.tick('startup');
    return true;
  }

  stop() {
    if (!this.timer) return false;
    this.clearIntervalImpl(this.timer);
    this.timer = null;
    return true;
  }
}
