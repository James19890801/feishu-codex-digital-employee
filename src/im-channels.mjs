const CHANNEL_TARGET_PATTERN = /^(dingtalk|wecom):(group|user):(.+)$/;

export function formatChannelChatId(channel, kind, id) {
  if (!['dingtalk', 'wecom'].includes(channel)) {
    throw new Error(`Unsupported IM channel: ${channel}`);
  }
  if (!['group', 'user'].includes(kind)) {
    throw new Error(`Unsupported IM target kind: ${kind}`);
  }
  const normalizedId = String(id || '').trim();
  if (!normalizedId) throw new Error('IM target ID is required');
  return `${channel}:${kind}:${normalizedId}`;
}

export function parseChannelChatId(chatId) {
  const match = String(chatId || '').match(CHANNEL_TARGET_PATTERN);
  if (!match) return null;
  return { channel: match[1], kind: match[2], id: match[3] };
}

export function buildDingTalkConsumerArgs(profile = '') {
  return [
    ...(profile ? ['--profile', profile] : []),
    'event', 'consume',
    'user_im_message_receive_at',
    'user_im_message_receive_o2o_all',
    '--flatten',
    '--format', 'ndjson',
  ];
}

export function buildDingTalkSendArgs(target, text, uuid = '') {
  if (target?.channel !== 'dingtalk') {
    throw new Error('DingTalk sender received a non-DingTalk target');
  }
  const recipient = target.kind === 'group'
    ? ['--group', target.id]
    : target.kind === 'user'
      ? ['--open-dingtalk-id', target.id]
      : null;
  if (!recipient) throw new Error(`Unsupported DingTalk target kind: ${target?.kind || ''}`);
  const args = [
    'chat', 'message', 'send',
    ...recipient,
    '--text', String(text || ''),
    '--ai-tag=false',
  ];
  if (uuid) args.push('--uuid', String(uuid).slice(0, 128));
  args.push('--yes', '--format', 'json');
  return args;
}

function normalizedTimestamp(value) {
  if (value === undefined || value === null || value === '') return String(Date.now());
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return String(numeric < 10_000_000_000 ? numeric * 1000 : numeric);
  }
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? String(parsed) : String(Date.now());
}

export function normalizeDingTalkEvent(event) {
  const type = String(event?.type || '');
  const group = type === 'user_im_message_receive_at';
  const direct = type === 'user_im_message_receive_o2o_all';
  if (!group && !direct) return null;
  const senderId = String(event?.sender_open_dingtalk_id || '').trim();
  const targetId = group
    ? String(event?.conversation_id || '').trim()
    : senderId;
  const messageId = String(event?.message_id || event?.event_id || '').trim();
  if (!messageId || !targetId || !senderId) return null;
  return {
    message: {
      message_id: `dingtalk:${messageId}`,
      chat_id: formatChannelChatId('dingtalk', group ? 'group' : 'user', targetId),
      chat_type: group ? 'group' : 'p2p',
      message_type: 'text',
      create_time: normalizedTimestamp(
        event?.create_time || event?.event_time || event?.timestamp,
      ),
      content: JSON.stringify({ text: String(event?.content || '') }),
      mentions: group ? [{ id: 'dingtalk-current-user' }] : [],
    },
    sender: {
      sender_type: 'user',
      sender_id: { open_id: `dingtalk:${senderId}` },
    },
    metadata: {
      channel: 'dingtalk',
      eventType: type,
    },
  };
}

function weComText(body) {
  if (body?.msgtype === 'text') return String(body?.text?.content || '');
  if (body?.msgtype === 'mixed') {
    return (body?.mixed?.msg_item || [])
      .filter(item => item?.msgtype === 'text')
      .map(item => String(item?.text?.content || '').trim())
      .filter(Boolean)
      .join('\n');
  }
  if (body?.msgtype === 'voice') {
    return String(body?.voice?.content || body?.voice?.text || '');
  }
  return '';
}

export function normalizeWeComFrame(frame) {
  const body = frame?.body || {};
  if (!['text', 'mixed', 'voice'].includes(body.msgtype)) return null;
  const senderId = String(body?.from?.userid || '').trim();
  const group = body.chattype === 'group';
  const targetId = group ? String(body.chatid || '').trim() : senderId;
  const messageId = String(body.msgid || frame?.headers?.req_id || '').trim();
  if (!messageId || !senderId || !targetId) return null;
  const text = weComText(body);
  if (!text) return null;
  return {
    message: {
      message_id: `wecom:${messageId}`,
      chat_id: formatChannelChatId('wecom', group ? 'group' : 'user', targetId),
      chat_type: group ? 'group' : 'p2p',
      message_type: 'text',
      create_time: normalizedTimestamp(body.create_time),
      content: JSON.stringify({ text }),
      mentions: group ? [{ id: 'wecom-bot' }] : [],
    },
    sender: {
      sender_type: 'user',
      sender_id: { open_id: `wecom:${senderId}` },
    },
    metadata: {
      channel: 'wecom',
      requestId: String(frame?.headers?.req_id || ''),
    },
  };
}
