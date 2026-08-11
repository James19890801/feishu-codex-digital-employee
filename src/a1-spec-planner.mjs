import { isExcludedIdentityText } from './identity-policy.mjs';

function requiredText(value, name, maxLength = 20_000) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${name} is required`);
  if (text.length > maxLength) throw new Error(`${name} is too long`);
  if (isExcludedIdentityText(text)) throw new Error(`${name} contains excluded identity ALT or legacy identity`);
  return text;
}

function stringList(value, name, { required = true, max = 20 } = {}) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const items = value.slice(0, max).map((item, index) => requiredText(item, `${name}[${index}]`, 4000));
  if (required && !items.length) throw new Error(`${name} is required`);
  return items;
}

export function buildA1SpecPrompt({
  request,
  route,
  clarification = '',
  existingBody = '',
  repositoryEvidence = '',
} = {}) {
  return `你是企业 AI 产品经理，负责把对方的原始诉求整理成可以直接写入 1A 的完整产品需求。

只输出 JSON，不要 Markdown 代码块，不要解释。JSON 结构：
{"title":"","background":"","goals":[""],"requirements":[{"name":"","detail":"","priority":"P0"}],"codeEvidence":[{"path":"","finding":""}],"acceptanceCriteria":[""],"risks":[""],"openQuestions":[""],"codeSearchTerms":[""]}

规则：
- 当前产品只能写 ${requiredText(route?.productName, 'productName', 200)}，不得混入其他产品或历史身份。
- 标题、背景、需求详细描述和验收标准必须具体，不能把原始一句话原样扩写成空洞套话。
- 信息不足时仍要形成基于已知事实的完整初版，并把最关键的问题放入 openQuestions，后续直接更新工作项。
- codeSearchTerms 给出 1 至 3 个适合在代码仓库中检索的英文标识符或中文业务词。
- 没有代码证据时 codeEvidence 输出空数组，不得虚构路径或实现。

目标仓库：${route?.repo || '非目标项目，不做代码检索'}
原始诉求：${requiredText(request, 'request')}
补充澄清：${clarification || '无'}
既有需求正文：${existingBody || '无'}
已读取的代码证据：${repositoryEvidence || '无'}`;
}

export function parseA1RequirementSpec(output = '') {
  let parsed;
  try {
    parsed = JSON.parse(String(output || '').trim());
  } catch (error) {
    throw new Error(`A1 requirement planner returned invalid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('A1 requirement planner JSON must be an object');
  }
  const title = requiredText(parsed.title, 'title', 500);
  const background = requiredText(parsed.background, 'background');
  const requirements = Array.isArray(parsed.requirements)
    ? parsed.requirements.slice(0, 30).map((item, index) => ({
        name: requiredText(item?.name, `requirements[${index}].name`, 500),
        detail: requiredText(item?.detail, `requirements[${index}].detail`),
        priority: requiredText(item?.priority || '待评估', `requirements[${index}].priority`, 50),
      }))
    : [];
  if (!requirements.length) throw new Error('requirements is required');
  const codeEvidence = Array.isArray(parsed.codeEvidence)
    ? parsed.codeEvidence.slice(0, 20).map((item, index) => ({
        path: requiredText(item?.path, `codeEvidence[${index}].path`, 2000),
        finding: requiredText(item?.finding, `codeEvidence[${index}].finding`, 4000),
      }))
    : [];
  return {
    title,
    background,
    goals: stringList(parsed.goals, 'goals'),
    requirements,
    codeEvidence,
    acceptanceCriteria: stringList(parsed.acceptanceCriteria, 'acceptanceCriteria'),
    risks: stringList(parsed.risks || [], 'risks', { required: false }),
    openQuestions: stringList(parsed.openQuestions || [], 'openQuestions', { required: false }),
    codeSearchTerms: stringList(parsed.codeSearchTerms || [], 'codeSearchTerms', { required: false, max: 3 }),
  };
}

export function extractRepositoryPaths(value) {
  const found = [];
  const visit = (current, depth = 0) => {
    if (depth > 8 || current === null || current === undefined) return;
    if (Array.isArray(current)) {
      current.forEach(item => visit(item, depth + 1));
      return;
    }
    if (typeof current !== 'object') return;
    for (const [key, item] of Object.entries(current)) {
      if (['path', 'filePath', 'file_path'].includes(key) && typeof item === 'string') {
        const path = item.trim();
        if (path && path.length <= 2000 && !path.startsWith('/') && !path.includes('..')
          && !path.endsWith('/')) found.push(path);
      } else visit(item, depth + 1);
    }
  };
  visit(value);
  return [...new Set(found)].slice(0, 12);
}
