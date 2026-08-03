const DOCX_URL_RE = /https?:\/\/[^\s/]*feishu\.cn\/docx\/([A-Za-z0-9]+)/i;

export function normalizeKnowledgeCatalog(catalog) {
  if (Array.isArray(catalog)) return { version: 1, sources: catalog };
  if (!catalog || Number(catalog.version) !== 2 || !Array.isArray(catalog.sources)) {
    throw new Error('Knowledge catalog must be an array or a version 2 object');
  }
  return { version: 2, sources: catalog.sources };
}

function catalogSources(catalog) {
  return normalizeKnowledgeCatalog(catalog).sources;
}

function containsExcludedScope(source) {
  return source?.status === 'excluded_scope'
    || /\bALT\b/iu.test(`${source?.title || ''}\n${source?.summary || ''}\n${source?.locator || ''}`);
}

export function filterKnowledgeSources(sources, { senderId = '', ownerId = '' } = {}) {
  const sender = String(senderId || '').trim();
  const owner = String(ownerId || '').trim();
  return (Array.isArray(sources) ? sources : []).filter(source => {
    if (!source || containsExcludedScope(source) || (source.status && source.status !== 'active')) return false;
    const sourceOwner = String(source.ownerId || '').trim();
    const readers = Array.isArray(source.readerIds) ? source.readerIds.map(String) : [];
    if (source.type === 'dingtalk_chat') return sender === sourceOwner || readers.includes(sender);
    return Boolean(sender && owner && sender === owner) || sender === sourceOwner || readers.includes(sender);
  });
}

export function normalizeKnowledgeText(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .replace(/号/g, '日');
}

export function looksLikeKnowledgeRequest(text = '') {
  return /(会议|纪要|文档|资料|知识|代码|仓库|钉钉|1A)/i.test(text);
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
  const sources = catalogSources(catalog);
  if (explicit) return sources.find(item => item.token === explicit) || { denied: true, token: explicit };
  const normalized = normalizeKnowledgeText(text);
  return sources.find(item => !containsExcludedScope(item) && [item.title, ...(item.aliases || [])]
    .some(alias => normalized.includes(normalizeKnowledgeText(alias)))) || null;
}

export function canReadDocument(document, senderOpenId, ownerOpenId) {
  if (!document || document.denied) return false;
  if (containsExcludedScope(document)) return false;
  if (senderOpenId === ownerOpenId) return true;
  return (document.readerOpenIds || document.readerIds || []).includes(senderOpenId);
}

export function tokenFromSearchResult(result) {
  return result?.result_meta?.token || String(result?.result_meta?.url || '').match(DOCX_URL_RE)?.[1] || '';
}

export function stripHighlight(value = '') {
  return String(value).replace(/<[^>]+>/g, '').trim();
}

export function sourceLine(document) {
  return `来源：《${document.title}》\n${document.url || document.locator || ''}`.trim();
}
