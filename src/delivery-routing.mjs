function channelProvider(chatId) {
  const value = String(chatId || '');
  if (value.startsWith('dingtalk:')) return 'dingtalk';
  if (value.startsWith('wecom:')) return 'wecom';
  if (value.startsWith('wechat:')) return 'wechat';
  return 'feishu';
}

// AIPRO deliberately does not infer an output format or create documents.
// Every request is handed to the selected local AI runtime as a normal reply.
export function buildDeliveryPlan({ chatId, request }) {
  void request;
  return {
    kind: 'message',
    provider: channelProvider(chatId),
    reason: 'agent_runtime',
  };
}
