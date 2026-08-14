import { parseDingTalkMediaPlaceholder } from './multimodal-content.mjs';

const LOOKBACK_MS = 30 * 60 * 1000;

function parseBody(item) {
  try {
    return JSON.parse(item?.body?.content || '{}');
  } catch {
    return {};
  }
}

function recentItems(items, { senderOpenId, currentTime, messageType }) {
  const earliestTime = currentTime - LOOKBACK_MS;
  return (Array.isArray(items) ? items : []).filter(item => item?.msg_type === messageType
    && item?.sender?.sender_type === 'user'
    && item?.sender?.id === senderOpenId
    && Number(item?.create_time) < currentTime
    && Number(item?.create_time) >= earliestTime);
}

export function refersToRecentImages(text = '') {
  return [
    /(上面|前面|刚才|刚刚|之前).{0,8}(图片|照片|截图|图)/,
    /这(?:一|两|二|三|四|几|些|\d+)张(?:图片|照片|截图)/,
    /(?:图片|照片|截图)(?:里|里面|中|上).{0,10}(?:什么|内容|吃的|写了什么|有什么)/,
    /(?:图片|照片|截图|图).{0,8}(?:没|未)(?:加载|显示|读到|看到|打开)/,
    /(?:发|上传|贴).{0,5}(?:一|两|二|三|四|几|些|\d+)张/,
    /(?:我|他|她|对方|别人).{0,6}发的(?:图|图片|照片|截图)/,
  ].some(pattern => pattern.test(text));
}

export function selectRecentDingTalkMediaRefs(items, {
  currentTime,
  parseTime = value => Date.parse(value || ''),
  conversationId = '',
  limit = 4,
} = {}) {
  const nowMs = Number(currentTime);
  if (!Number.isFinite(nowMs)) return [];
  const earliestTime = nowMs - LOOKBACK_MS;
  return (Array.isArray(items) ? items : [])
    .map(item => {
      const messageId = String(item?.openMessageId || item?.messageId || item?.message_id || '').trim();
      const itemConversationId = String(
        item?.openConversationId || item?.open_conversation_id || conversationId,
      ).trim();
      const occurredAtMs = Number(parseTime(item?.createTime || item?.create_time || ''));
      const media = parseDingTalkMediaPlaceholder(item?.content || item?.text || '');
      if (!messageId || !itemConversationId || !media
        || itemConversationId !== String(conversationId || itemConversationId)
        || !Number.isFinite(occurredAtMs)
        || occurredAtMs >= nowMs || occurredAtMs < earliestTime) return null;
      return {
        occurredAtMs,
        kind: media.kind,
        resourceId: media.resourceId,
        messageId,
        conversationId: itemConversationId,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.occurredAtMs - b.occurredAtMs)
    .slice(-Math.max(1, Number(limit) || 4))
    .map(({ occurredAtMs: _occurredAtMs, ...ref }) => ref);
}

export function refersToRecentFiles(text = '') {
  return [
    /(上面|前面|刚才|刚刚|之前).{0,10}(文件|文档|附件|PDF|Word|表格)/i,
    /这(?:个|份|些)?(?:文件|文档|附件|PDF|Word|表格).{0,12}(?:总结|内容|看看|分析|阅读|提取|是什么)/i,
    /(?:总结|看看|分析|阅读|提取).{0,10}(?:文件|文档|附件|PDF|Word|表格)/i,
  ].some(pattern => pattern.test(text));
}

export function requestedImageLimit(text = '') {
  if (/(?:一|1)张/.test(text)) return 1;
  if (/(?:两|二|2)张/.test(text)) return 2;
  if (/(?:三|3)张/.test(text)) return 3;
  return 4;
}

export function selectRecentImageRefs(items, {
  senderOpenId,
  currentTime,
  limit = 4,
}) {
  return recentItems(items, { senderOpenId, currentTime, messageType: 'image' })
    .map(item => {
      const content = parseBody(item);
      return content.image_key
        ? { messageId: item.message_id, fileKey: content.image_key }
        : null;
    })
    .filter(Boolean)
    .slice(0, limit)
    .reverse();
}

export function selectRecentFileRefs(items, {
  senderOpenId,
  currentTime,
  limit = 4,
}) {
  return recentItems(items, { senderOpenId, currentTime, messageType: 'file' })
    .map(item => {
      const content = parseBody(item);
      return content.file_key ? {
        messageId: item.message_id,
        fileKey: content.file_key,
        fileName: content.file_name || '',
      } : null;
    })
    .filter(Boolean)
    .slice(0, Math.max(1, Number(limit) || 4))
    .reverse();
}

export function selectRecentFileRef(items, options) {
  return selectRecentFileRefs(items, { ...options, limit: 1 })[0] || null;
}
