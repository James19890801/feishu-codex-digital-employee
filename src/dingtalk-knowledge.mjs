import {
  extractKnowledgeQuery,
  filterKnowledgeSources,
  looksLikeKnowledgeRequest,
  normalizeKnowledgeCatalog,
  normalizeKnowledgeText,
} from './knowledge.mjs';

const DINGTALK_DOC_HOST = 'alidocs.dingtalk.com';
const DINGTALK_NODE_PATH = /^\/i\/nodes\/([A-Za-z0-9_-]{8,256})\/?$/u;
const DOCUMENT_NODE_ID = /^[A-Za-z0-9_-]{8,256}$/u;
const URL_TRAILING_PUNCTUATION = /[，。！？；：、）】》”’.,!?;:)\]}>'"]+$/u;

function boundedLimit(value, fallback, maximum) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(1, Math.min(maximum, Math.trunc(numeric)));
}

function parseDingTalkDocumentUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== DINGTALK_DOC_HOST) {
    return null;
  }
  const nodeId = parsed.pathname.match(DINGTALK_NODE_PATH)?.[1] || '';
  return DOCUMENT_NODE_ID.test(nodeId) ? { nodeId, url: String(value) } : null;
}

function normalizedNode(value) {
  const node = String(value || '').trim();
  if (DOCUMENT_NODE_ID.test(node)) return node;
  return parseDingTalkDocumentUrl(node)?.nodeId || '';
}

export function extractDingTalkDocumentRefs(text = '') {
  const matches = String(text || '').match(/https?:\/\/[^\s<>，。！？；：、（）【】《》“”‘’]+/giu) || [];
  const refs = [];
  const seen = new Set();
  for (const match of matches) {
    const candidate = match.replace(URL_TRAILING_PUNCTUATION, '');
    const ref = parseDingTalkDocumentUrl(candidate);
    if (!ref || seen.has(ref.nodeId)) continue;
    seen.add(ref.nodeId);
    refs.push(ref);
  }
  return refs;
}

export function buildDingTalkSearchArgs({ query, profile = '', limit = 8 } = {}) {
  const normalizedQuery = String(query || '').trim();
  const normalizedProfile = String(profile || '').trim();
  if (!normalizedQuery) throw new Error('DingTalk document search query is required');
  if (!normalizedProfile) throw new Error('DingTalk profile is required');
  return [
    '--profile', normalizedProfile,
    'drive', 'search',
    '--query', normalizedQuery,
    '--limit', String(boundedLimit(limit, 8, 30)),
    '--format', 'json',
    '--yes',
  ];
}

export function buildDingTalkReadArgs({ node, profile = '' } = {}) {
  const nodeId = normalizedNode(node);
  const normalizedProfile = String(profile || '').trim();
  if (!nodeId) throw new Error('Valid DingTalk document node is required');
  if (!normalizedProfile) throw new Error('DingTalk profile is required');
  return [
    '--profile', normalizedProfile,
    'doc', 'read',
    '--node', nodeId,
    '--format', 'json',
    '--yes',
  ];
}

export function normalizeDingTalkSearchResults(payload, query = '', limit = 3) {
  const documents = payload?.doc_results?.success === true
    && Array.isArray(payload.doc_results.documents)
    ? payload.doc_results.documents
    : [];
  const normalizedQuery = normalizeKnowledgeText(query);
  return documents
    .map((document, index) => {
      const nodeId = normalizedNode(document?.nodeId);
      const title = String(document?.name || document?.title || '').trim();
      if (!nodeId || !title) return null;
      const normalizedTitle = normalizeKnowledgeText(title);
      const rank = normalizedQuery && normalizedTitle === normalizedQuery
        ? 0
        : normalizedQuery && normalizedTitle.includes(normalizedQuery)
          ? 1
          : 2;
      return {
        nodeId,
        title,
        url: String(document?.docUrl || `https://${DINGTALK_DOC_HOST}/i/nodes/${nodeId}`).trim(),
        rank,
        index,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .slice(0, boundedLimit(limit, 3, 3))
    .map(({ rank: _rank, index: _index, ...document }) => document);
}

function normalizedContentLimit(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric) : fallback;
}

function normalizedActorId(value) {
  return String(value || '').trim().replace(/^dingtalk:/u, '');
}

function isOwner(senderId, ownerIds) {
  const sender = normalizedActorId(senderId);
  return Boolean(sender) && (Array.isArray(ownerIds) ? ownerIds : [])
    .some(ownerId => normalizedActorId(ownerId) === sender);
}

function authorizedCatalogReference(text, catalog, senderId, ownerIds) {
  const normalizedText = normalizeKnowledgeText(text);
  const ownerId = (Array.isArray(ownerIds) ? ownerIds : [])[0] || '';
  const normalizedSources = normalizeKnowledgeCatalog(catalog).sources.map(source => ({
    ...source,
    ownerId: normalizedActorId(source?.ownerId),
    readerIds: Array.isArray(source?.readerIds)
      ? source.readerIds.map(normalizedActorId)
      : [],
  }));
  const sources = filterKnowledgeSources(
    normalizedSources,
    { senderId: normalizedActorId(senderId), ownerId: normalizedActorId(ownerId) },
  );
  const source = sources.find(item => item?.type === 'dingtalk_doc'
    && [item.title, ...(item.aliases || [])]
      .some(alias => normalizedText.includes(normalizeKnowledgeText(alias))));
  if (!source) return null;
  const nodeId = normalizedNode(source.locator);
  if (!nodeId) return null;
  return {
    nodeId,
    title: String(source.title || '').trim(),
    url: String(source.url || `https://${DINGTALK_DOC_HOST}/i/nodes/${nodeId}`),
  };
}

async function readDingTalkDocument(reference, {
  profile,
  runDws,
  maxDocumentChars,
} = {}) {
  try {
    const payload = await runDws(buildDingTalkReadArgs({
      node: reference.nodeId,
      profile,
    }));
    const nodeId = normalizedNode(payload?.nodeId);
    const title = String(payload?.title || '').trim();
    const markdown = String(payload?.markdown || '').trim();
    if (payload?.success !== true || !nodeId || nodeId !== reference.nodeId || !title) {
      return { failure: { nodeId: reference.nodeId, reason: 'invalid_response' } };
    }
    if (!markdown) {
      return { failure: { nodeId, reason: 'empty_content' } };
    }
    return {
      document: {
        nodeId,
        title,
        url: String(payload?.docUrl || reference.url || `https://${DINGTALK_DOC_HOST}/i/nodes/${nodeId}`),
        content: markdown.slice(0, maxDocumentChars),
      },
    };
  } catch {
    return { failure: { nodeId: reference.nodeId, reason: 'read_failed' } };
  }
}

export async function retrieveDingTalkKnowledge({
  text = '',
  senderId = '',
  ownerIds = [],
  catalog = { version: 2, sources: [] },
  profile = '',
  runDws,
  maxDocumentChars = 40_000,
  maxTotalChars = 60_000,
} = {}) {
  if (typeof runDws !== 'function') throw new Error('DingTalk knowledge runner is required');
  let references = extractDingTalkDocumentRefs(text).slice(0, 3);
  if (!references.length && !looksLikeKnowledgeRequest(text)) return null;
  if (!references.length && isOwner(senderId, ownerIds)) {
    const query = extractKnowledgeQuery(text);
    if (!query) return null;
    let searchPayload;
    try {
      searchPayload = await runDws(buildDingTalkSearchArgs({ query, profile, limit: 8 }));
    } catch {
      return {
        source: 'dingtalk',
        documents: [],
        failures: [{ reason: 'search_failed' }],
        unavailable: true,
      };
    }
    references = normalizeDingTalkSearchResults(searchPayload, query, 3);
  }
  if (!references.length && !isOwner(senderId, ownerIds)) {
    const catalogReference = authorizedCatalogReference(text, catalog, senderId, ownerIds);
    if (catalogReference) references = [catalogReference];
  }
  if (!references.length) {
    return {
      source: 'dingtalk',
      documents: [],
      failures: [],
      notFound: true,
    };
  }
  const perDocumentLimit = normalizedContentLimit(maxDocumentChars, 40_000);
  const totalLimit = normalizedContentLimit(maxTotalChars, 60_000);
  const documents = [];
  const failures = [];
  let remainingChars = totalLimit;
  for (const reference of references) {
    if (remainingChars <= 0) break;
    const result = await readDingTalkDocument(reference, {
      profile,
      runDws,
      maxDocumentChars: Math.min(perDocumentLimit, remainingChars),
    });
    if (result.document) {
      documents.push(result.document);
      remainingChars -= result.document.content.length;
    }
    if (result.failure) failures.push(result.failure);
  }
  return {
    source: 'dingtalk',
    documents,
    failures,
    ...(documents.length ? {} : { unavailable: true }),
  };
}
