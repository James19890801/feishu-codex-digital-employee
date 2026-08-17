const GRADE_CONTEXT = /(?:同学|岗位|招聘|招人|招一个|招个|HC|hc|层级|职级|级别|定级|晋升|晋|绩效|汇报|管理|leader|TL|序列|几级|向上汇报)/u;

const GLOSSARY = new Map([
  ['同学', '企业协作语境中的同事或相关人员，不表示在校学生。'],
  ['拿结果', '对最终业务或产品结果负责，不止完成动作。'],
  ['闭环', '从提出、执行、验证到反馈全部完成并可追踪。'],
  ['抓手', '能推动目标落地的具体机制、产品能力或行动入口。'],
  ['颗粒度', '描述或拆解事项的细致程度。'],
  ['横向', '跨团队、跨职能或同层协作。'],
  ['纵向', '沿汇报线、层级或上下游链路推进。'],
  ['owner', '对事项最终推进与结果负责的人。'],
  ['对焦', '把目标、范围、判断或分歧重新对齐。'],
  ['共识', '相关方对目标、判断和行动形成一致理解。'],
  ['体感', '使用者或一线人员对实际体验的主观感受。'],
  ['链路', '从输入到结果的完整流程及系统连接关系。'],
  ['沉淀', '把一次性经验转成可复用文档、机制、数据或能力。'],
  ['复盘', '回看目标、过程、结果和原因，提炼后续改进。'],
  ['卡点', '阻碍事项继续推进的具体问题或依赖。'],
  ['倒排', '从目标完成时间反向拆解里程碑和截止时间。'],
]);

function historyText(history) {
  if (typeof history === 'string') return history;
  if (!Array.isArray(history)) return '';
  return history.map(item => String(item?.content || '')).filter(Boolean).join('\n');
}

function excludedNumberUse(text, digit) {
  const escaped = String(digit);
  const patterns = [
    new RegExp(`${escaped}\\s*月|月\\s*${escaped}|${escaped}\\s*[日号]`, 'u'),
    new RegExp(`${escaped}\\s*(?:万|万元|块|元|人民币)`, 'u'),
    new RegExp(`${escaped}\\s*(?:个|人|位|条|项|页|次|份|台|套|组)`, 'u'),
    new RegExp(`(?:V|v|版本)\\s*${escaped}`, 'u'),
    new RegExp(`${escaped}\\s*(?:分钟|小时|天|周|个月|年)`, 'u'),
    new RegExp(`(?:需求|缺陷|任务|ID|id|编号)\\s*${escaped}\\d*`, 'u'),
    new RegExp(`第\\s*${escaped}\\s*(?:页|章|条|项)`, 'u'),
  ];
  return patterns.some(pattern => pattern.test(text));
}

function standaloneGrades(text) {
  return [...String(text || '').matchAll(/(?<![0-9A-Za-z])([5-9])(?![0-9])/gu)]
    .map(match => match[1]);
}

export function annotateOrganizationLanguage(text = '', history = []) {
  const current = String(text || '').trim();
  const prior = historyText(history);
  const combined = `${prior}\n${current}`.trim();
  const annotations = [];

  const promotion = current.match(/(?<!\d)([5-9])\s*晋\s*([5-9])(?!\d)/u);
  if (promotion) {
    annotations.push(`“${promotion[1]}晋${promotion[2]}”表示从 P${promotion[1]} 晋升到 P${promotion[2]}。`);
  }

  const gradeContext = GRADE_CONTEXT.test(combined) || /[Pp][5-9]/u.test(combined);
  const digits = [...new Set(standaloneGrades(current))];
  const gradeDigits = digits.filter(digit => gradeContext && !excludedNumberUse(current, digit));
  for (const digit of gradeDigits) {
    if (promotion?.slice(1).includes(digit)) continue;
    annotations.push(`“${digit}”在当前人员或职级语境中表示 P${digit}，不是普通数量。`);
  }

  for (const [term, meaning] of GLOSSARY) {
    const pattern = term === 'owner' ? /\bowner\b/i : null;
    if (pattern ? pattern.test(current) : current.includes(term)) {
      annotations.push(`“${term}”：${meaning}`);
    }
  }

  const hasExcludedLiteral = digits.some(digit => excludedNumberUse(current, digit));
  const ambiguous = digits.length > 0
    && gradeDigits.length === 0
    && !hasExcludedLiteral
    && !promotion;

  return { annotations: [...new Set(annotations)], ambiguous };
}

export function formatOrganizationLanguageAnnotations(result = {}) {
  const annotations = Array.isArray(result.annotations) ? result.annotations : [];
  return [
    '企业语境注释：',
    annotations.length
      ? annotations.map(item => `- ${item}`).join('\n')
      : '（本轮没有需要补充的企业语义）',
  ].join('\n');
}
