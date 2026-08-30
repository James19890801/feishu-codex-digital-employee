const DIRECT_REQUEST = /^(?:(?:请|麻烦|辛苦|劳驾|能不能|能否|可不可以|可以|帮忙|帮我|帮|来)请?\s*)?(?:回复|回答|回应|说说|说两句|讲讲|看看|看一下|看下|点评|评论|解读|分析|总结|判断|解释|处理|查一下|查下|给个建议|给点建议|帮忙|帮我)/u;
const SUBJECT_REQUEST = /^(?:这个|这件事|这篇|这条|这张|上面|前面|引用的?).{0,12}(?:怎么看|如何看|看法|点评|评论|解读|分析|总结|判断|解释|回复|回答)/u;
const DESCRIPTIVE_PREFIX = /^(?:上次|刚才|之前|曾经|已经|今天|也|的)/u;

function normalizedText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function escapedPattern(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function directlyRequestsAlias(content, aliases) {
  for (const alias of aliases) {
    const pattern = escapedPattern(alias);
    if (!pattern) continue;
    const match = new RegExp(pattern, 'iu').exec(content);
    if (!match) continue;
    const after = content
      .slice(match.index + match[0].length)
      .replace(/^[\s，,。！!？?：:~～—-]+/u, '')
      .trim();
    if (!after || DESCRIPTIVE_PREFIX.test(after)) continue;
    if (DIRECT_REQUEST.test(after) || SUBJECT_REQUEST.test(after)) return true;
  }
  return false;
}

export function decideWeChatGroupReplyPolicy({
  channel,
  chatType,
  text,
  explicitMention = false,
  aliases = [],
} = {}) {
  if (channel !== 'wechat' || chatType !== 'group') {
    return {
      applies: false,
      shouldReply: false,
      reasonCode: 'not_wechat_group',
      responseRequired: false,
    };
  }
  if (explicitMention) {
    return {
      applies: true,
      shouldReply: true,
      reasonCode: 'explicit_mention',
      responseRequired: true,
    };
  }
  const content = normalizedText(text);
  const normalizedAliases = [...new Set((Array.isArray(aliases) ? aliases : [])
    .map(normalizedText)
    .filter(Boolean))];
  if (content && directlyRequestsAlias(content, normalizedAliases)) {
    return {
      applies: true,
      shouldReply: true,
      reasonCode: 'direct_alias_request',
      responseRequired: true,
    };
  }
  return {
    applies: true,
    shouldReply: false,
    reasonCode: 'passive_group_context',
    responseRequired: false,
  };
}
