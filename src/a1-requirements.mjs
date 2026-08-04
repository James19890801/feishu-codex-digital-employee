import { isExcludedIdentityText } from './identity-policy.mjs';

const ROUTES = Object.freeze({
  webagent: Object.freeze({
    key: 'webagent',
    productName: 'WebAgent',
    projectId: '2165415',
    projectName: 'WebAgent需求池',
    repo: 'enterprise-development/ai-lab-agent',
    branch: '',
    inspectRepository: true,
    classificationPending: false,
    needsClarification: false,
  }),
  'ai-collaboration': Object.freeze({
    key: 'ai-collaboration',
    productName: 'AI协同空间',
    projectId: '2168196',
    projectName: 'AI采购协同空间',
    repo: 'enterprise-development/ai-native-flow-platform',
    branch: 'feature/20260606_29656382_init_project_1',
    inspectRepository: true,
    classificationPending: false,
    needsClarification: false,
  }),
});

function requiredText(value, name, maxLength = 20_000) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${name} is required`);
  if (text.length > maxLength) throw new Error(`${name} is too long`);
  if (isExcludedIdentityText(text)) throw new Error(`${name} contains excluded identity ALT or legacy identity`);
  return text;
}

export function resolveProductRoute(product = '') {
  const input = String(product || '').trim();
  if (isExcludedIdentityText(input)) throw new Error('ALT is excluded from product routing');
  if (!input) {
    return {
      key: '', productName: '', projectId: '', projectName: '', repo: '', branch: '',
      inspectRepository: false, classificationPending: false, needsClarification: true,
    };
  }
  if (/web\s*agent|webagent|网页智能体/i.test(input)) return { ...ROUTES.webagent };
  if (/AI\s*(?:采购)?协同空间|协同空间|ai-native-flow-platform/i.test(input)) {
    return { ...ROUTES['ai-collaboration'] };
  }
  return {
    key: 'other',
    productName: input,
    projectId: ROUTES.webagent.projectId,
    projectName: ROUTES.webagent.projectName,
    repo: '',
    branch: '',
    inspectRepository: false,
    classificationPending: true,
    needsClarification: false,
  };
}

export function classifyRequirementIntent(message = '') {
  const text = String(message || '').trim();
  if (!text) return 'none';
  if (/(?:需求|工作项).{0,12}(?:进展|进度|状态|怎么样|到哪)|(?:查|看).{0,12}(?:需求池|工作项)/i.test(text)) {
    return 'requirement_progress';
  }
  if (/(?:更新|修改|补充|完善|变更).{0,20}(?:需求|工作项|\d{6,})|\d{6,}.{0,20}(?:更新|修改|补充|完善)/i.test(text)) {
    return 'requirement_update';
  }
  if (/(?:新建|创建|提|登记|录入|帮我做).{0,20}(?:需求|工作项)|(?:有个|有一个|需要).{0,20}需求/i.test(text)) {
    return 'requirement_create';
  }
  return 'none';
}

function listItems(values, fallback) {
  const items = Array.isArray(values) ? values.map(value => String(value || '').trim()).filter(Boolean) : [];
  return (items.length ? items : [fallback]).map(item => `- ${item}`).join('\n');
}

export function buildRequirementBody(input = {}) {
  const productName = requiredText(input.productName, 'productName', 200);
  const title = requiredText(input.title, 'title', 500);
  const background = requiredText(input.background || '待结合现状与提出方补充信息持续完善。', 'background');
  const requirements = Array.isArray(input.requirements) ? input.requirements : [];
  const rows = requirements.length ? requirements : [{
    name: title,
    detail: '依据背景、代码定位和后续澄清信息完成产品方案与交付。',
    priority: '待评估',
  }];
  const table = rows.map((item, index) => {
    const name = requiredText(item?.name, `requirements[${index}].name`, 500).replaceAll('|', '\\|');
    const detail = requiredText(item?.detail, `requirements[${index}].detail`).replaceAll('|', '\\|').replaceAll('\n', '<br>');
    const priority = String(item?.priority || '待评估').trim().replaceAll('|', '\\|');
    return `| ${index + 1} | ${name} | ${detail} | ${priority} |`;
  }).join('\n');
  const evidence = Array.isArray(input.codeEvidence) && input.codeEvidence.length
    ? input.codeEvidence.map(item => `- \`${requiredText(item?.path, 'codeEvidence.path', 1000)}\`：${requiredText(item?.finding, 'codeEvidence.finding')}`).join('\n')
    : '- 非目标项目或尚未取得代码证据；不据此虚构技术定位。';

  return `## 需求主体

本需求面向 **${productName}**：${title}。

## 背景与现状

${background}

## 目标

${listItems(input.goals, `完成“${title}”的可验证交付闭环。`)}

## 需求清单

| 序号 | 需求 | 详细描述 | 优先级 |
| --- | --- | --- | --- |
${table}

## 需求详细描述

${rows.map((item, index) => `### ${index + 1}. ${item.name}\n\n${item.detail}`).join('\n\n')}

## 代码定位与影响范围

${evidence}

## 验收标准

${listItems(input.acceptanceCriteria, '实际结果可回读、可验证，失败时不误报成功。')}

## 风险与约束

${listItems(input.risks, '不得把未经验证的推断写成已确认事实。')}

## 待澄清项

${listItems(input.openQuestions, '暂无；如实施中发现信息缺口，直接追问并持续更新本工作项。')}`;
}
