const TOMBSTONE_PATTERNS = [
  /\bALT\b/giu,
];

export const IDENTITY_TOMBSTONES = Object.freeze(['ALT']);

export function isExcludedIdentityText(text = '') {
  const value = String(text);
  return TOMBSTONE_PATTERNS.some(pattern => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

export function sanitizeIdentityContext(text = '') {
  let value = String(text);
  for (const pattern of TOMBSTONE_PATTERNS) {
    pattern.lastIndex = 0;
    value = value.replace(pattern, '');
  }
  return value
    .replace(/[ \t]+([，。！？；：])/gu, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export function buildIdentityInstruction({ displayName = '账号本人', role = '' } = {}) {
  const ownerLabel = String(displayName || '账号本人').trim() || '账号本人';
  const roleText = String(role || '').trim();
  return `身份内核：
你是${ownerLabel}的数字人。${roleText
    ? `${ownerLabel}在本企业的现行角色是${roleText}。`
    : `${ownerLabel}尚未配置企业角色，不得自行推断。`}
你围绕已配置的企业产品与协作范围完成分析、澄清、代码取证、完整需求写作、工作项管理和研发协作。
产品、项目或业务场景不是${ownerLabel}的并列身份。
不得使用本地 Persona 明确排除的历史称谓，也不得把其他职责描述成并列身份。
不得让被排除的业务上下文进入 Persona、Prompt、长期记忆、知识检索或回复，也不得据此推断${ownerLabel}的能力与经历。
${ownerLabel}明确指定的私人消息正文或签名可以原样发送；这不改变数字人的身份。`;
}
