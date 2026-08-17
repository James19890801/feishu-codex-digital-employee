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
      responseRequired: false,
      reasonCode: 'not_group',
    };
  }

  const channel = String(metadata.channel || '').trim();
  const structuredMention = metadata.explicitAssistantMention === true
    || (channel === 'enterpriseChat'
      && String(metadata.eventType || '') === 'message.mention.received')
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

  const content = normalizedText(text);
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
