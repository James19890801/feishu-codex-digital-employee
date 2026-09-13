import { parseChannelChatId, prepareGroupMention } from '../src/im-channels.mjs';

const INTENT = /^[a-f0-9]{64}$/;

function messageId(payload, keys, depth = 0) {
  if (!payload || typeof payload !== 'object' || depth > 4) return '';
  for (const key of keys) {
    if (typeof payload[key] === 'string' && payload[key].trim()) return payload[key].trim();
  }
  for (const nested of Object.values(payload)) {
    const found = messageId(nested, keys, depth + 1);
    if (found) return found;
  }
  return '';
}

function targetFor(event, channel, text, intentKey) {
  const target = parseChannelChatId(event?.message?.chat_id);
  if (target?.channel !== channel || !INTENT.test(intentKey || '')
    || typeof text !== 'string' || !text.trim() || text.length > 16_000) {
    throw new Error('invalid_cloud_send');
  }
  return target;
}

export function createChannelSenders({ gewe, dws, channels = ['wechat', 'dingtalk'] } = {}) {
  if (!Array.isArray(channels) || channels.length === 0
    || new Set(channels).size !== channels.length
    || channels.some(channel => !['wechat', 'dingtalk'].includes(channel))) {
    throw new TypeError('invalid channel selection');
  }
  if (channels.includes('wechat') && typeof gewe?.send !== 'function'
    || channels.includes('dingtalk') && typeof dws?.send !== 'function') {
    throw new TypeError('selected channel providers are required');
  }
  const senders = {
    wechat: { async send({ event, text, intentKey }) {
      const target = targetFor(event, 'wechat', text, intentKey);
      let content = text;
      let options = {};
      if (target.kind === 'group') {
        const senderId = String(event?.sender?.sender_id?.open_id || '').replace(/^wechat:/, '');
        if (!senderId || typeof gewe.prepareGroupMention !== 'function') {
          throw new Error('mention_unavailable');
        }
        const mention = await gewe.prepareGroupMention(target, text, { atWxids: [senderId] });
        if (!mention?.content || !mention?.ats) throw new Error('mention_unavailable');
        content = mention.content;
        options = { ats: mention.ats };
      }
      const result = await gewe.send(target, content, options);
      if (Number(result?.ret) !== 200) throw new Error('wechat_send_unconfirmed');
      const receiptId = messageId(result, ['newMsgId', 'new_msg_id', 'msgId', 'msg_id', 'messageId', 'message_id']);
      return receiptId ? { receiptId } : {};
    } },
    dingtalk: { async send({ event, text, intentKey }) {
      const target = targetFor(event, 'dingtalk', text, intentKey);
      let content = text;
      let options = {};
      if (target.kind === 'group') {
        const senderId = String(event?.sender?.sender_id?.open_id || '');
        if (!senderId.startsWith('dingtalk:')) throw new Error('mention_unavailable');
        const mention = prepareGroupMention({ chatId: event.message.chat_id,
          chatType: 'group', senderIds: [senderId], text });
        if (!mention.atOpenDingTalkIds.length) throw new Error('mention_unavailable');
        content = mention.text;
        options = { atOpenDingTalkIds: mention.atOpenDingTalkIds };
      }
      const result = await dws.send(target, content, intentKey, options);
      if (result?.success === false || result?.error) throw new Error('dingtalk_send_unconfirmed');
      // A queued openTaskId is not a provider message receipt.
      const receiptId = messageId(result, ['openMessageId', 'open_message_id', 'messageId', 'message_id']);
      return receiptId ? { receiptId } : {};
    } },
  };
  return Object.fromEntries(channels.map(channel => [channel, senders[channel]]));
}
