import { extractHttpUrls } from './web-reader.mjs';

function compactItem(item) {
  return Object.fromEntries(Object.entries(item).filter(([, value]) => (
    value !== undefined && value !== null && value !== ''
  )));
}

export function buildInboundContentEnvelope({
  message = {},
  senderId = '',
  text = '',
  imageRefs = [],
  fileRefs = [],
  metadata = {},
  maxUrls = 2,
  maxItems = 12,
} = {}) {
  const channel = String(metadata.channel || (
    String(message.chat_id || '').startsWith('enterpriseChat:') ? 'enterpriseChat' : 'feishu'
  ));
  const items = [];
  for (const ref of imageRefs) {
    items.push(compactItem({
      kind: 'image', source: 'feishu',
      messageId: ref.messageId, resourceId: ref.fileKey,
    }));
  }
  for (const ref of fileRefs) {
    items.push(compactItem({
      kind: 'document', source: 'feishu',
      messageId: ref.messageId, resourceId: ref.fileKey, fileName: ref.fileName,
    }));
  }
  if (metadata.file?.resourceId) {
    items.push(compactItem({
      kind: 'document', source: 'enterpriseChat',
      resourceId: metadata.file.resourceId,
      fileName: metadata.file.fileName,
      messageId: metadata.file.messageId,
      conversationId: metadata.file.conversationId,
    }));
  }
  if (metadata.media?.resourceId) {
    items.push(compactItem({
      kind: metadata.media.kind || 'file', source: 'enterpriseChat',
      resourceId: metadata.media.resourceId,
      fileName: metadata.media.fileName,
      messageId: metadata.media.messageId,
      conversationId: metadata.media.conversationId,
    }));
  }
  for (const url of extractHttpUrls(text, maxUrls)) {
    items.push({ kind: 'web', source: 'url', url });
  }
  const limit = Math.max(1, Number(maxItems) || 12);
  return {
    messageId: String(message.message_id || ''),
    channel,
    chatId: String(message.chat_id || ''),
    chatType: String(message.chat_type || ''),
    senderId: String(senderId || ''),
    text: String(text || ''),
    items: items.slice(0, limit),
    truncatedItems: Math.max(0, items.length - limit),
  };
}
