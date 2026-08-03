import {
  formatConversationContext,
} from './conversation-context.mjs';
import {
  annotateAlibabaLanguage,
  formatAlibabaLanguageAnnotations,
} from './alibaba-language.mjs';
import { parseChannelChatId } from './im-channels.mjs';

function dingTalkTime(timestampMs) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(timestampMs));
  const value = type => parts.find(part => part.type === type)?.value || '';
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}:${value('second')}`;
}

export function buildDingTalkReplyHistoryRequest({
  message = {}, senderOpenId = '', cleanText = '', metadata = {},
} = {}) {
  const target = parseChannelChatId(message.chat_id);
  if (target?.channel !== 'dingtalk' || !['user', 'group'].includes(target.kind)) {
    throw new Error('A DingTalk message target is required for live reply context');
  }
  const createdAtMs = Number(message.create_time);
  if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) {
    throw new Error('A valid DingTalk message create time is required');
  }
  const normalizedSenderId = String(senderOpenId || '').replace(/^dingtalk:/, '').trim();
  if (!normalizedSenderId) throw new Error('A DingTalk sender ID is required');
  const conversationId = String(message.chat_id || '');
  return {
    kind: target.kind === 'group' ? 'group' : 'direct',
    targetId: target.id,
    beforeTime: dingTalkTime(createdAtMs + 1_000),
    conversationId,
    currentMessage: {
      messageId: String(message.message_id || ''),
      conversationId,
      senderId: normalizedSenderId,
      senderName: String(metadata.senderName || metadata.conversationTitle || '').trim(),
      content: String(cleanText || '').trim(),
      createdAt: dingTalkTime(createdAtMs),
    },
  };
}

export class ReplyContextUnavailableError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = 'ReplyContextUnavailableError';
    this.code = 'CONVERSATION_HISTORY_UNAVAILABLE';
  }
}

export class ReplyContextService {
  constructor({ contextClient, ownerLabel = '账号本人' } = {}) {
    if (!contextClient || typeof contextClient.fetch !== 'function') {
      throw new Error('Reply context requires a conversation context client');
    }
    this.contextClient = contextClient;
    this.ownerLabel = String(ownerLabel || '账号本人').trim() || '账号本人';
  }

  async prepare({ task = '', historyRequest = {} } = {}) {
    let context;
    try {
      context = await this.contextClient.fetch(historyRequest);
    } catch (error) {
      throw new ReplyContextUnavailableError(
        `Current conversation history is unavailable: ${String(error?.message || error)}`,
        { cause: error },
      );
    }
    const currentTarget = String(context?.latestCounterpartyMessage?.content || '').trim();
    if (!currentTarget) {
      throw new ReplyContextUnavailableError('Current conversation has no validated reply target');
    }
    const styles = Array.isArray(context.styleSamples) ? context.styleSamples : [];
    const language = annotateAlibabaLanguage(task, context.messages);
    return {
      context,
      historyPrompt: formatConversationContext(context, { ownerLabel: this.ownerLabel }),
      currentTarget,
      stylePrompt: styles.length
        ? styles.map(item => `${this.ownerLabel}：${item.content}`).join('\n')
        : '（无，使用 Persona 默认风格）',
      languagePrompt: formatAlibabaLanguageAnnotations(language),
      languageAmbiguous: language.ambiguous,
      ownerLabel: this.ownerLabel,
    };
  }
}

export function buildReplyContextInstruction(prepared = {}, { ownerLabel = prepared.ownerLabel || '账号本人' } = {}) {
  return [
    '本轮真实会话理解规则：',
    '1. 先回应“当前回应目标”。最近30条只用于消歧，不要回到已经结束的话题。',
    `2. 风格样本只来自${ownerLabel}本人；模仿表达方式但不复制承诺、隐私或历史事实。`,
    `3. 如果没有${ownerLabel}样本，使用 Persona 默认风格。不要向对方解释内部读取或模仿过程。`,
    '',
    String(prepared.historyPrompt || ''),
    '',
    String(prepared.languagePrompt || ''),
  ].join('\n').trim();
}

export async function executeGroundedReply({
  contextService,
  task = '',
  historyRequest = {},
  generate,
} = {}) {
  if (!contextService || typeof contextService.prepare !== 'function') {
    throw new Error('Grounded reply requires a reply context service');
  }
  if (typeof generate !== 'function') {
    throw new Error('Grounded reply requires an AI generation function');
  }
  const prepared = await contextService.prepare({ task, historyRequest });
  return generate({
    task,
    prepared,
    replyContextInstruction: buildReplyContextInstruction(prepared),
  });
}
