import { isExplicitCreateRequest } from './multica-task-routing.mjs';

function clean(value, limit = 0) {
  const text = String(value || '').trim();
  return limit > 0 ? text.slice(0, limit) : text;
}

export function looksLikePotentialMulticaCreate(value) {
  const text = clean(value, 1200);
  if (!text || !/(?:创建|新建|建一个|建个|发起|登记|提交)/u.test(text)) return false;
  return /(?:issue|医企|议题|问题单|需求|任务|调研|研究|方案|报告|课题|项目)/iu.test(text);
}

export function buildMulticaCreateIntentPrompt({
  text = '',
  channel = '',
  history = '',
} = {}) {
  return [
    '你是 Multica 创建意图分类器，只判断用户是否明确要求数字人新建一个 Multica Issue。',
    '要理解口语、语音转写错误和同音词，例如“医企”可能是英文 Issue 的误转写。',
    '不要把创建日程、会议、待办、文档、群聊、账号、报名或付款本身误判为创建 Issue。',
    '只有用户明确要求建单来承接需求、调研、项目或任务时，isCreateIssue 才能为 true。',
    '不确定时必须返回 false 和 low。只输出一行 JSON，不要 Markdown：',
    '{"isCreateIssue":true或false,"confidence":"high或low","reason":"简短理由"}',
    `channel=${JSON.stringify(clean(channel, 40))}`,
    `currentMessage=${JSON.stringify(clean(text, 1200))}`,
    `recentHistory=${JSON.stringify(clean(history, 2400))}`,
  ].join('\n');
}

function parseJsonObject(output) {
  const raw = typeof output === 'string'
    ? output
    : clean(output?.text || output?.output || output?.content);
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseMulticaCreateIntentDecision(output) {
  const decision = parseJsonObject(output);
  if (!decision) return { matched: false, confidence: 'low', reason: 'invalid_json' };
  const confidence = clean(decision.confidence).toLowerCase();
  if (confidence !== 'high') {
    return { matched: false, confidence: 'low', reason: 'low_confidence' };
  }
  const matched = decision.isCreateIssue === true;
  return {
    matched,
    confidence: 'high',
    reason: clean(decision.reason, 300) || (matched ? 'semantic_match' : 'semantic_reject'),
  };
}

export async function resolveMulticaCreateIntent({
  text = '',
  channel = '',
  history = '',
  runAi,
} = {}) {
  if (isExplicitCreateRequest(text)) {
    return { matched: true, source: 'deterministic', confidence: 'high', reason: 'parser_match' };
  }
  if (!looksLikePotentialMulticaCreate(text)) {
    return { matched: false, source: 'none', confidence: 'low', reason: 'not_candidate' };
  }
  if (typeof runAi !== 'function') {
    return { matched: false, source: 'semantic', confidence: 'low', reason: 'ai_unavailable' };
  }
  try {
    const output = await runAi(buildMulticaCreateIntentPrompt({ text, channel, history }));
    return { ...parseMulticaCreateIntentDecision(output), source: 'semantic' };
  } catch {
    return { matched: false, source: 'semantic', confidence: 'low', reason: 'ai_error' };
  }
}
