import { parseWorkspaceSelection } from './multica-task-routing.mjs';

function clean(value, limit = 0) {
  const text = String(value || '').trim();
  return limit > 0 ? text.slice(0, limit) : text;
}

function candidateRows(workspaces) {
  return (Array.isArray(workspaces) ? workspaces : [])
    .filter(item => clean(item?.id))
    .slice(0, 100)
    .map((item, index) => ({
      index: index + 1,
      id: clean(item.id, 160),
      name: clean(item.name, 240),
      slug: clean(item.slug, 160),
    }));
}

export function buildWorkspaceSelectionPrompt({
  response = '',
  request = '',
  history = '',
  workspaces = [],
} = {}) {
  const candidates = candidateRows(workspaces);
  return [
    '你是 Multica 空间选择解析器，只判断用户指向了哪个候选空间，不执行任何写操作。',
    '结合用户当前回复、原始需求和最近对话，理解序号、位置指代、简称和业务语义。',
    '只能从 candidates 中选择；不确定、存在多个合理候选或没有候选时，workspaceId 必须为空且 confidence 必须为 low。',
    '只有唯一明确时才能返回 confidence=high。不得发明 ID。',
    '只输出一行 JSON，不要 Markdown：{"workspaceId":"候选id或空字符串","confidence":"high或low","reason":"简短理由"}',
    `currentResponse=${JSON.stringify(clean(response, 400))}`,
    `originalRequest=${JSON.stringify(clean(request, 1200))}`,
    `recentHistory=${JSON.stringify(clean(history, 3000))}`,
    `candidates=${JSON.stringify(candidates)}`,
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

export function parseWorkspaceSelectionDecision(output, workspaces = []) {
  const decision = parseJsonObject(output);
  if (!decision) {
    return { workspace: null, confidence: 'low', reason: 'invalid_json' };
  }
  const confidence = clean(decision.confidence).toLowerCase();
  const workspaceId = clean(decision.workspaceId);
  if (confidence !== 'high') {
    return { workspace: null, confidence: 'low', reason: 'low_confidence' };
  }
  const matches = (Array.isArray(workspaces) ? workspaces : [])
    .filter(item => clean(item?.id) === workspaceId);
  if (matches.length !== 1) {
    return { workspace: null, confidence: 'low', reason: 'unknown_workspace' };
  }
  return {
    workspace: matches[0],
    confidence: 'high',
    reason: clean(decision.reason, 300) || 'semantic_match',
  };
}

export async function resolveWorkspaceSelection({
  response = '',
  request = '',
  history = '',
  workspaces = [],
  fallbackWorkspaceId = '',
  runAi,
} = {}) {
  const deterministic = parseWorkspaceSelection(response, workspaces, fallbackWorkspaceId);
  if (deterministic) {
    return { workspace: deterministic, source: 'deterministic', reason: 'parser_match' };
  }
  if (typeof runAi !== 'function') {
    return { workspace: null, source: 'semantic', reason: 'ai_unavailable' };
  }
  try {
    const output = await runAi(buildWorkspaceSelectionPrompt({
      response,
      request,
      history,
      workspaces,
    }));
    const decision = parseWorkspaceSelectionDecision(output, workspaces);
    return { ...decision, source: 'semantic' };
  } catch {
    return { workspace: null, source: 'semantic', reason: 'ai_error' };
  }
}

export function buildWorkspaceSelectionRetryQuestion(missing = ['workspace']) {
  const needsRequirement = (Array.isArray(missing) ? missing : []).includes('requirement');
  if (needsRequirement) {
    return '我还不能唯一确定目标空间，也缺少要创建的具体事项。请回复空间序号或完整名称，并补充 Issue 要解决什么问题、交付什么结果。';
  }
  return '我还不能唯一确定目标空间。请回复空间序号或完整名称；需要我重发候选列表时，直接说“重发空间列表”。';
}

export function looksLikeSemanticWorkspaceSelectionReply(value) {
  const text = clean(value).replace(/[。！!]+$/u, '').trim();
  if (!text || text.length > 80 || /[\n！？?；;]/u.test(text)) return false;
  if (/^(?:大家|各位)?(?:早上|上午|中午|下午|晚上)?好(?:呀|啊|哦)?$/u.test(text)) return false;
  return /(?:第[一二两三四五六七八九十百\d]+个|最后(?:一)?个|倒数|前面|后面|上面|下面|刚才|之前|那个|这个|那边|这边|选|放到|放在|挂到|归到|空间|workspace|培训|特训|公开课)/iu.test(text);
}
