import { normalizeKnowledgeText } from './knowledge.mjs';

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
