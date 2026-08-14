import { isExcludedIdentityText } from './identity-policy.mjs';

const ALLOWED_KINDS = new Set([
  'profile',
  'preference',
  'product_method',
  'project_fact',
  'decision',
  'follow_up',
]);

const SENSITIVE_PATTERN = /(?:一次性口令|验证码|密码|私钥|access[_ -]?token|client[_ -]?secret)\s*[:：]?\s*\S+/iu;

export function validateMemoryCandidate(candidate = {}) {
  const kind = String(candidate.kind || '').trim();
  const subject = String(candidate.subject || '').trim();
  const content = String(candidate.content || '').trim();
  const sourceRefs = Array.isArray(candidate.sourceRefs)
    ? candidate.sourceRefs.map(value => String(value || '').trim()).filter(Boolean)
    : [];

  if (!ALLOWED_KINDS.has(kind)) return { accepted: false, reason: 'unsupported_kind' };
  if (!subject || !content) return { accepted: false, reason: 'incomplete_memory' };
  if (sourceRefs.length === 0) return { accepted: false, reason: 'missing_source' };
  if (/\bALT\b/iu.test(`${subject}\n${content}`) || isExcludedIdentityText(`${subject}\n${content}`)) {
    return { accepted: false, reason: 'excluded_scope' };
  }
  if (SENSITIVE_PATTERN.test(content)) return { accepted: false, reason: 'sensitive_content' };
  return { accepted: true, reason: '' };
}

export function normalizeMemoryCandidate(candidate = {}) {
  const validation = validateMemoryCandidate(candidate);
  if (!validation.accepted) throw new Error(`Memory candidate rejected: ${validation.reason}`);
  return {
    memoryId: String(candidate.memoryId || '').trim(),
    kind: String(candidate.kind).trim(),
    subject: String(candidate.subject).trim(),
    content: String(candidate.content).trim(),
    sourceRefs: candidate.sourceRefs.map(value => String(value).trim()).filter(Boolean),
    confidence: ['confirmed', 'inferred', 'unverified'].includes(candidate.confidence)
      ? candidate.confidence : 'unverified',
    validFrom: String(candidate.validFrom || '').trim(),
    validUntil: String(candidate.validUntil || '').trim(),
  };
}
