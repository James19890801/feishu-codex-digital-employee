import { dirname } from 'node:path';
import { matchHumanTakeoverCommand } from './human-takeover.mjs';

const CHANNEL_TARGET_PATTERN = /^(dingtalk|wecom|wechat):(group|user):(.+)$/;
const DINGTALK_SELF_FILE_PLACEHOLDER = /^(?:\[文件\]\s*)+.*\bfileId\s*:/i;

export function buildDingTalkProcessEnv({
  dingtalkBin,
  dingtalkChannel = '',
  nodeBin = '',
  pathEnv = '',
  baseEnv = {},
} = {}) {
  const executable = String(dingtalkBin || '').trim();
  if (!executable) throw new Error('DingTalk executable path is required');
  const channel = String(dingtalkChannel || '').trim();
  return {
    ...baseEnv,
    ...(channel ? { DWS_CHANNEL: channel } : {}),
    PATH: [dirname(executable), String(nodeBin || ''), String(pathEnv || '')]
      .filter(Boolean)
      .join(':'),
  };
}

export function formatChannelChatId(channel, kind, id) {
  if (!['dingtalk', 'wecom', 'wechat'].includes(channel)) {
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

export function prepareGroupMention({ chatId, chatType, senderId, text }) {
  const content = String(text || '');
  if (chatType !== 'group') return { text: content, atOpenDingTalkIds: [] };
  const target = parseChannelChatId(chatId);
  if (target?.channel === 'dingtalk' && target.kind === 'group') {
    const openDingTalkId = String(senderId || '').replace(/^dingtalk:/, '').trim();
    if (!openDingTalkId) return { text: content, atOpenDingTalkIds: [] };
    return {
      text: `<@${openDingTalkId}>\n${content}`,
      atOpenDingTalkIds: [openDingTalkId],
    };
  }
  const openId = String(senderId || '').trim();
  if (!target && /^ou_[A-Za-z0-9]+$/.test(openId)) {
    return {
      text: `<at user_id="${openId}">发起人</at>\n${content}`,
      atOpenDingTalkIds: [],
    };
  }
  return { text: content, atOpenDingTalkIds: [] };
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

export function buildDingTalkListAllPollingArgs(start, end, cursor = '0') {
  const startTime = String(start || '').trim();
  const endTime = String(end || '').trim();
  if (!startTime || !endTime) throw new Error('DingTalk polling start and end times are required');
  return [
    'chat', 'message', 'list-all',
    '--start', startTime,
    '--end', endTime,
    '--limit', '50',
    '--cursor', String(cursor || '0'),
    '--format', 'json',
  ];
}

export function buildDingTalkSelfPollingArgs(profile, userId, start) {
  return [
    ...(profile ? ['--profile', profile] : []),
    'chat', 'message', 'list',
    '--user', String(userId || ''),
    '--time', String(start || ''),
    '--direction', 'newer',
    '--limit', '50',
    '--format', 'json',
  ];
}

export function buildDingTalkConversationPollingArgs(profile, target, start) {
  if (target?.channel !== 'dingtalk' || !['group', 'user'].includes(target?.kind)) {
    throw new Error('A DingTalk group or user target is required for conversation polling');
  }
  const targetId = String(target.id || '').trim();
  if (!targetId) throw new Error('DingTalk target ID is required for conversation polling');
  const recipient = target.kind === 'group'
    ? ['--group', targetId]
    : ['--open-dingtalk-id', targetId];
  return [
    ...(profile ? ['--profile', profile] : []),
    'chat', 'message', 'list',
    ...recipient,
    '--time', String(start || ''),
    '--direction', 'older',
    '--limit', '50',
    '--format', 'json',
  ];
}

export function buildDingTalkSendArgs(target, text, uuid = '', {
  atOpenDingTalkIds = [],
  transport = 'event-stream',
} = {}) {
  if (target?.channel !== 'dingtalk') {
    throw new Error('DingTalk sender received a non-DingTalk target');
  }
  const targetId = String(target.id || '').trim();
  if (!targetId) throw new Error('DingTalk target ID is required for sending');
  const recipient = target.kind === 'group'
    ? ['--group', targetId]
    : target.kind === 'user'
      ? ['--open-dingtalk-id', targetId]
      : null;
  if (!recipient) throw new Error(`Unsupported DingTalk target kind: ${target?.kind || ''}`);
  const content = String(text || '');
  const args = [
    'chat', 'message', 'send',
    ...recipient,
    '--text', content,
  ];
  if (transport !== 'wukong-polling') args.push('--ai-tag=false');
  const mentionIds = target.kind === 'group'
    ? [...new Set(atOpenDingTalkIds.map(value => String(value || '').trim()).filter(Boolean))]
      .slice(0, 20)
    : [];
  if (mentionIds.some(id => !content.includes(`<@${id}>`))) {
    throw new Error('DingTalk mention placeholder is required for every mentioned user');
  }
  if (mentionIds.length) args.push('--at-open-dingtalk-ids', mentionIds.join(','));
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

export function normalizeDingTalkSelfMessages(result) {
  const root = result?.result || result?.data || result || {};
  const messages = Array.isArray(root) ? root : (root.messages || root.items || []);
  return (Array.isArray(messages) ? messages : []).flatMap(item => {
    const messageId = String(item?.openMessageId || item?.messageId || item?.message_id || '').trim();
    const senderId = String(
      item?.senderOpenDingTalkId || item?.sender_open_dingtalk_id || '',
    ).trim();
    const content = String(item?.content || item?.text || '').trim();
    if (!messageId || !senderId || !content) return [];
    // DWS represents files in a self-chat as text placeholders and does not
    // expose whether they were sent by the human or by AIPRO. AIPRO cannot
    // read these placeholders as files, and treating its own delivered file
    // as a new request creates an unbounded file-reply loop. Fail closed until
    // DWS exposes a reliable message direction or media-origin field.
    if (DINGTALK_SELF_FILE_PLACEHOLDER.test(content)) return [];
    return [{
      message: {
        message_id: `dingtalk:${messageId}`,
        chat_id: formatChannelChatId('dingtalk', 'user', senderId),
        chat_type: 'p2p',
        message_type: 'text',
        create_time: normalizedTimestamp(item?.createTime || item?.create_time),
        content: JSON.stringify({ text: content }),
        mentions: [],
      },
      sender: {
        sender_type: 'user',
        sender_id: { open_id: `dingtalk:${senderId}` },
      },
      metadata: {
        channel: 'dingtalk',
        selfChat: true,
        source: 'self-poll',
        conversationId: String(
          item?.openConversationId || item?.open_conversation_id || '',
        ),
      },
    }];
  });
}

export function normalizeDingTalkListAllPage(result, {
  ownerOpenId = '',
  ownerNames = [],
  mentionNames = [],
} = {}) {
  const root = result?.result || result?.data || result || {};
  const conversations = Array.isArray(root?.conversationMessagesList)
    ? root.conversationMessagesList
    : [];
  const ownerId = String(ownerOpenId || '').trim();
  const normalizedOwnerNames = new Set(
    (Array.isArray(ownerNames) ? ownerNames : [])
      .map(value => String(value || '').trim())
      .filter(Boolean),
  );
  const normalizedMentionNames = (Array.isArray(mentionNames) ? mentionNames : [])
    .map(value => String(value || '').trim())
    .filter(Boolean);
  const payloads = [];

  for (const conversation of conversations) {
    const singleChat = conversation?.singleChat === true;
    const conversationId = String(conversation?.openConversationId || '').trim();
    const conversationTitle = String(conversation?.title || '').trim();
    const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
    if (!conversationId) continue;
    for (const item of messages) {
      const messageId = String(item?.openMessageId || item?.messageId || '').trim();
      const senderId = String(item?.senderOpenDingTalkId || '').trim();
      const content = String(item?.content || '').trim();
      if (!messageId || !senderId || !content) continue;
      if (/^\[(?:图片|文件|视频)消息\]/.test(content) || /^\[文件\]/.test(content)) continue;

      let targetId = '';
      let selfChat = false;
      if (singleChat) {
        if (senderId === ownerId) {
          selfChat = normalizedOwnerNames.has(conversationTitle);
          if (!selfChat) continue;
        }
        targetId = senderId;
      } else {
        if (senderId === ownerId) continue;
        const mentioned = normalizedMentionNames.some(name => (
          content.includes(`@${name}`) || content.includes(`＠${name}`)
        ));
        if (!mentioned) continue;
        targetId = conversationId;
      }

      payloads.push({
        message: {
          message_id: `dingtalk:${messageId}`,
          chat_id: formatChannelChatId('dingtalk', singleChat ? 'user' : 'group', targetId),
          chat_type: singleChat ? 'p2p' : 'group',
          message_type: 'text',
          create_time: normalizedTimestamp(item?.createTime),
          content: JSON.stringify({ text: content }),
          mentions: singleChat ? [] : [{ id: 'dingtalk-current-user' }],
        },
        sender: {
          sender_type: 'user',
          sender_id: { open_id: `dingtalk:${senderId}` },
        },
        metadata: {
          channel: 'dingtalk',
          source: 'wukong-poll',
          selfChat,
          conversationId,
          conversationTitle,
        },
      });
    }
  }

  return {
    payloads,
    hasMore: root?.hasMore === true,
    nextCursor: String(root?.nextCursor || '0'),
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

function nestedString(value) {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  return String(value?.string ?? '');
}

function splitGeWeGroupContent(content) {
  const match = String(content || '').match(/^([^:\n]{3,200}):\n([\s\S]*)$/);
  if (!match) return { senderId: '', text: String(content || '') };
  return { senderId: match[1].trim(), text: match[2] };
}

function geWeV1Mentioned(msgSource, selfWxid) {
  const match = String(msgSource || '').match(/<atuserlist[^>]*>(?:<!\[CDATA\[)?([^<\]]*)/i);
  if (!match) return false;
  return match[1]
    .split(/[;,]/)
    .map(value => value.trim())
    .includes(selfWxid);
}

function geWeV2Mentioned(event, selfWxid, mentionNames) {
  const ids = [
    event?.atWxids,
    event?.atUserList,
    event?.ats,
    event?.mentionedWxids,
  ].flatMap(value => Array.isArray(value) ? value : String(value || '').split(/[;,]/));
  if (ids.map(value => String(value).trim()).includes(selfWxid)) return true;
  return (mentionNames || []).some(name => {
    const normalized = String(name || '').trim();
    return normalized && String(event?.content || '').includes(`@${normalized}`);
  });
}

export function normalizeGeWeWebhook(event, { mentionNames = [] } = {}) {
  const v1 = Boolean(event?.Data);
  const data = v1 ? event.Data : event;
  const appId = String(v1 ? event?.Appid : event?.appid || '').trim();
  const selfWxid = String(v1 ? event?.Wxid : event?.wxid || '').trim();
  const messageType = v1 ? Number(data?.MsgType) : String(data?.msgType || '').toUpperCase();
  const isText = v1
    ? String(event?.TypeName || '') === 'AddMsg' && messageType === 1
    : messageType === 'TEXT';
  if (!isText || !appId || !selfWxid) return null;
  const fromUser = nestedString(v1 ? data?.FromUserName : data?.fromUser).trim();
  const toUser = nestedString(v1 ? data?.ToUserName : data?.toUser).trim();
  const rawContent = nestedString(v1 ? data?.Content : data?.content);
  const messageId = nestedString(v1 ? data?.NewMsgId : data?.newMsgId).trim();
  const isSelf = v1
    ? fromUser === selfWxid
    : data?.isSelf === true || fromUser === selfWxid;
  if (!messageId || !fromUser) return null;

  const group = fromUser.endsWith('@chatroom') || toUser.endsWith('@chatroom');
  const groupId = fromUser.endsWith('@chatroom') ? fromUser : toUser;
  const parsedGroup = group ? splitGeWeGroupContent(rawContent) : null;
  if (isSelf && !matchHumanTakeoverCommand(rawContent)) return null;
  const senderId = isSelf
    ? selfWxid
    : group
    ? String(
        (v1 ? '' : data?.senderWxid || data?.sender || data?.memberWxid)
        || parsedGroup?.senderId
        || '',
      ).trim()
    : fromUser;
  if (!senderId || (!isSelf && senderId === selfWxid)) return null;
  const mentioned = isSelf || !group
    || (v1
      ? geWeV1Mentioned(data?.MsgSource, selfWxid)
      : geWeV2Mentioned(data, selfWxid, mentionNames));
  if (!mentioned) return null;
  const text = isSelf ? rawContent : group ? parsedGroup.text : rawContent;
  if (!String(text).trim()) return null;
  const targetId = group ? groupId : isSelf ? toUser : senderId;
  if (!targetId) return null;

  return {
    message: {
      message_id: `wechat:${appId}:${messageId}`,
      chat_id: formatChannelChatId('wechat', group ? 'group' : 'user', targetId),
      chat_type: group ? 'group' : 'p2p',
      message_type: 'text',
      create_time: normalizedTimestamp(v1 ? data?.CreateTime : data?.createTime),
      content: JSON.stringify({ text: String(text) }),
      mentions: group ? [{ id: 'wechat-current-user' }] : [],
    },
    sender: {
      sender_type: 'user',
      sender_id: { open_id: `wechat:${senderId}` },
    },
    metadata: {
      channel: 'wechat',
      appId,
      ...(isSelf ? { ownerControlAuthenticated: true, operatorControl: true } : {}),
      callbackVersion: v1 ? 'v1' : 'v2',
    },
  };
}
