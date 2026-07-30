const DOCX_URL_RE = /https?:\/\/[^\s/]*feishu\.cn\/docx\/([A-Za-z0-9]+)/i;

export function normalizeKnowledgeText(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .replace(/号/g, '日');
}

export function looksLikeKnowledgeRequest(text = '') {
  return /(会议|纪要|文档|资料|飞书)/.test(text);
}

export function extractKnowledgeQuery(text = '') {
  return String(text)
    .replace(/^@[^\s]+\s*/i, '')
    .replace(/^(?:麻烦|请|可以|能不能|能否)?\s*(?:帮我)?\s*(?:查一下|找一下|搜索|总结一下|总结|看看|看一下)\s*/i, '')
    .replace(/(?:主要)?(?:讲了|说了|包含|有哪些|是什么)(?:什么)?(?:内容)?[？?。！!]*$/i, '')
    .replace(/[“”"']/g, '')
    .trim();
}

export function resolveCatalogDocument(text, catalog) {
  const explicit = String(text).match(DOCX_URL_RE)?.[1];
  if (explicit) return catalog.find(item => item.token === explicit) || { denied: true, token: explicit };
  const normalized = normalizeKnowledgeText(text);
  return catalog.find(item => [item.title, ...(item.aliases || [])]
    .some(alias => normalized.includes(normalizeKnowledgeText(alias)))) || null;
}

export function canReadDocument(document, senderOpenId, ownerOpenId) {
  if (!document || document.denied) return false;
  if (senderOpenId === ownerOpenId) return true;
  return (document.readerOpenIds || []).includes(senderOpenId);
}

export function tokenFromSearchResult(result) {
  return result?.result_meta?.token || String(result?.result_meta?.url || '').match(DOCX_URL_RE)?.[1] || '';
}

export function stripHighlight(value = '') {
  return String(value).replace(/<[^>]+>/g, '').trim();
}

export function sourceLine(document) {
  return `来源：《${document.title}》\n${document.url}`;
}
