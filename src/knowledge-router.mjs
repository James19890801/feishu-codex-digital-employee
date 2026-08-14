export async function resolveRealtimeKnowledge({
  channel = '',
  resolveDingTalk,
  resolveFeishu,
} = {}) {
  if (channel === 'dingtalk') {
    if (typeof resolveDingTalk !== 'function') {
      throw new Error('DingTalk resolver is required for DingTalk knowledge');
    }
    return resolveDingTalk();
  }
  if (channel === 'feishu') {
    if (typeof resolveFeishu !== 'function') {
      throw new Error('Feishu resolver is required for Feishu knowledge');
    }
    return resolveFeishu();
  }
  return null;
}

export function groundDingTalkKnowledgeTask({ task = '', result } = {}) {
  const baseTask = String(task || '');
  if (!result || result.source !== 'dingtalk') return baseTask;
  if (result.unavailable && !result.documents?.length) {
    return '钉钉文档刚刚没有读取成功。请明确说明未读取，不要猜测内容；建议对方检查链接或稍后重试。';
  }
  if (result.notFound && !result.documents?.length) {
    return '没有找到匹配的钉钉文档。请自然说明未找到，并建议对方补充更准确的标题或直接发送文档链接。';
  }
  const documents = Array.isArray(result.documents) ? result.documents : [];
  if (!documents.length) return baseTask;
  const material = documents.map(document => [
    `《${document.title}》`,
    String(document.content || ''),
    `来源：${document.url}`,
  ].join('\n')).join('\n\n---\n\n');
  const partial = Array.isArray(result.failures) && result.failures.length
    ? `\n\n另有 ${result.failures.length} 份钉钉文档未读取成功，不要猜测未读取内容。`
    : '';
  return `${baseTask}\n\n下面是当前消息明确提供或对提问者已授权的钉钉资料。请只依据资料回答，不要编造；回答末尾保留来源标题和链接：\n\n${material}${partial}`;
}
