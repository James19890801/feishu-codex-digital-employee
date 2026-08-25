const MAX_RESPONSE_ALIASES = 20;

function normalizedText(value) {
  return String(value || '').normalize('NFKC').trim();
}

function escapedPattern(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function explicitlyMentionsAlias(content, alias) {
  const target = escapedPattern(alias);
  if (!target) return false;
  return new RegExp(`[@＠]\\s*${target}(?=$|[\\s，,。！？!?::：;；])`, 'iu').test(content);
}

function mentionTokenCount(content) {
  return [...String(content || '').matchAll(
    /(?:^|[\s，,。！？!?；;、])[@＠]\s*[^\s，,。！？!?；;、]+/gu,
  )].length;
}

export function normalizeResponseMentionAliases(values = [], defaults = []) {
  const inputs = [
    ...(Array.isArray(values) ? values : []),
    ...(Array.isArray(defaults) ? defaults : []),
  ];
  return [...new Set(inputs
    .map(normalizedText)
    .filter(Boolean))]
    .slice(0, MAX_RESPONSE_ALIASES);
}

export function assessResponseObligation({
  message = {},
  metadata = {},
  text = '',
  aliases = [],
} = {}) {
  if (String(message.chat_type || '') !== 'group') {
    return {
      explicitAssistantMention: false,
      responseRequired: true,
      reasonCode: 'direct_message',
    };
  }

  const channel = String(metadata.channel || '').trim();
  const content = normalizedText(text);
  if (channel === 'dingtalk'
    && String(metadata.eventType || '') === 'user_im_message_receive_at'
    && mentionTokenCount(content) > 1) {
    return {
      explicitAssistantMention: true,
      responseRequired: false,
      reasonCode: 'multi_mention_broadcast',
    };
  }
  const structuredMention = metadata.explicitAssistantMention === true
    || (channel === 'dingtalk'
      && String(metadata.eventType || '') === 'user_im_message_receive_at')
    || (channel === 'feishu'
      && Array.isArray(message.mentions)
      && message.mentions.length > 0);
  if (structuredMention) {
    return {
      explicitAssistantMention: true,
      responseRequired: true,
      reasonCode: 'structured_assistant_mention',
    };
  }

  const assistantMention = normalizeResponseMentionAliases(aliases)
    .some(alias => explicitlyMentionsAlias(content, alias));
  if (assistantMention) {
    return {
      explicitAssistantMention: true,
      responseRequired: true,
      reasonCode: 'assistant_alias_mention',
    };
  }

  return {
    explicitAssistantMention: false,
    responseRequired: false,
    reasonCode: /[@＠]/u.test(content) ? 'other_mention' : 'not_addressed',
  };
}

export function responseObligationSkipAudit({ message = {}, obligation = {}, channel = '' } = {}) {
  if (String(message.chat_type || '') !== 'group' || obligation.responseRequired === true) return null;
  return {
    event: 'message_skipped_group_no_response_obligation',
    detail: {
      channel: String(channel || ''),
      reasonCode: String(obligation.reasonCode || 'not_addressed'),
    },
  };
}
