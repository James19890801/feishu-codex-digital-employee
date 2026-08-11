const CHANNELS = new Set(['dingtalk', 'feishu', 'wecom', 'wechat']);

function bounded(value, maximum = 160) {
  return String(value || '').trim().slice(0, maximum);
}

function channelIdentity(value) {
  const text = bounded(value, 300);
  const match = text.match(/^(dingtalk|feishu|wecom|wechat):(.+)$/u);
  return match ? { channel: match[1], id: match[2] } : { channel: '', id: text };
}

function directTarget(chatId) {
  const match = bounded(chatId, 500).match(/^(dingtalk|feishu|wecom|wechat):user:(.+)$/u);
  return match ? { channel: match[1], id: match[2] } : null;
}

export function normalizeCommunicationBlocklist(entries = []) {
  return (Array.isArray(entries) ? entries : [])
    .map(entry => {
      const channel = bounded(entry?.channel, 20).toLowerCase();
      const ids = [...new Set([
        entry?.openId,
        entry?.userId,
        ...(Array.isArray(entry?.ids) ? entry.ids : []),
      ].map(value => bounded(value, 300)).filter(Boolean))];
      return {
        channel: CHANNELS.has(channel) ? channel : '',
        displayName: bounded(entry?.displayName, 80),
        ids,
      };
    })
    .filter(entry => entry.channel && entry.ids.length)
    .slice(0, 200);
}

export function automaticCommunicationDecision({ senderId = '', chatId = '' } = {}, entries = []) {
  const sender = channelIdentity(senderId);
  const target = directTarget(chatId);
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const senderMatches = sender.channel === entry.channel && entry.ids.includes(sender.id);
    const targetMatches = target?.channel === entry.channel && entry.ids.includes(target.id);
    if (senderMatches || targetMatches) {
      return { blocked: true, channel: entry.channel, entryIndex: index };
    }
  }
  return { blocked: false, channel: sender.channel || target?.channel || '', entryIndex: -1 };
}

export function canSendBlockedRecipient({ blocked = false, explicitOwnerAuthorized = false } = {}) {
  return !blocked || explicitOwnerAuthorized === true;
}

export function applyAutomaticInboundBlock({ payload, source = '', blocklist = [], state } = {}) {
  const message = payload?.message || {};
  const senderId = payload?.sender?.sender_id?.open_id || '';
  const decision = automaticCommunicationDecision({
    senderId,
    chatId: message.chat_id || '',
  }, blocklist);
  if (!decision.blocked) return false;
  if (!state || typeof state.seedInbound !== 'function' || typeof state.audit !== 'function') {
    throw new Error('Automatic communication block requires durable state');
  }
  const inserted = state.seedInbound(message.message_id, 'automatic-communication-block', payload);
  const completedExisting = !inserted
    && typeof state.hasInbound === 'function'
    && state.hasInbound(message.message_id)
    && typeof state.completeInbound === 'function';
  if (completedExisting) state.completeInbound(message.message_id);
  if (inserted || completedExisting) {
    state.audit('automatic_communication_blocked', {
      chatId: message.chat_id || '',
      senderId,
      messageId: message.message_id || '',
      detail: { source, channel: decision.channel, phase: 'inbound' },
    });
  }
  return true;
}
