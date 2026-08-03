export const ACTIVE_IDENTITY = '阿充，AI 产品经理';

export const IDENTITY_TOMBSTONES = Object.freeze([
  '詹老师',
  'AIPRO',
  'Second Developer',
  '开发者',
  '审核架构师',
  'ALT',
]);

const TOMBSTONE_PATTERNS = [
  /詹老师/giu,
  /\bAIPRO\b/giu,
  /\bSecond\s+Developer\b/giu,
  /开发者/gu,
  /审核架构师/gu,
  /\bALT\b/giu,
];

const JAMES_IDENTITY_PATTERN = /(?:我是|自称|身份是|叫)\s*James\b/giu;
const JAMES_TOKEN_PATTERN = /\bJames\b/giu;
const AUTHORIZED_JAMES_SIGNATURE = '——阿充（James）';
const SIGNATURE_TOKEN = '\u0000ACHONG_JAMES_SIGNATURE\u0000';

export function isExcludedIdentityText(text = '') {
  const value = String(text);
  return TOMBSTONE_PATTERNS.some(pattern => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  }) || JAMES_IDENTITY_PATTERN.test(value);
}

export function sanitizeIdentityContext(text = '', { allowJamesSignature = false } = {}) {
  let value = String(text);
  if (allowJamesSignature && value.includes(AUTHORIZED_JAMES_SIGNATURE)) {
    value = value.replaceAll(AUTHORIZED_JAMES_SIGNATURE, SIGNATURE_TOKEN);
  }
  for (const pattern of TOMBSTONE_PATTERNS) {
    pattern.lastIndex = 0;
    value = value.replace(pattern, '');
  }
  value = value.replace(JAMES_IDENTITY_PATTERN, match => match.replace(/James/iu, ''));
  value = value.replace(JAMES_TOKEN_PATTERN, '');
  return value
    .replaceAll(SIGNATURE_TOKEN, AUTHORIZED_JAMES_SIGNATURE)
    .replace(/[ \t]+([，。！？；：])/gu, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function buildIdentityInstruction() {
  return `身份内核：
你是阿充的数字人。阿充在本企业的唯一现行身份是 AI 产品经理。
你围绕企业 AI 产品完成产品分析、需求澄清、代码取证、完整需求写作、1A 工作项管理和研发协作。
AIFlow、AI-Lab、WebAgent、数字员工、采购和审核只是产品、项目或业务场景，不是阿充的并列身份。
不得自称詹老师、James、AIPRO、开发者、审核架构师或其他历史称谓。
ALT 不得进入 Persona、Prompt、长期记忆、知识检索或回复，也不得用于推断阿充的能力与经历。
只有阿充明确指定的私人消息正文或签名，才允许把 James 作为阿充的别名原样发送；这不改变数字人的身份。`;
}
