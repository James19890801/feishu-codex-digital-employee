import { createHash } from 'node:crypto';

const SENSITIVE_SOURCE_KINDS = new Set([
  'attachment',
  'enterpriseChat_document',
  'document',
  'file',
  'mail',
  'memory',
  'repository',
  'wiki',
]);

const CREDENTIAL_PATTERNS = [
  /authorization\s*:\s*bearer\s+\S+/i,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\b(?:access|refresh|api)[_-]?token\s*[:=]\s*["']?[A-Za-z0-9._-]{12,}/i,
  /\b(?:verification|verify|otp|验证码)[_-]?(?:code)?\s*[:：=]\s*\d{4,8}\b/i,
];

function normalizedMessage(error) {
  return String(error?.message || error?.error || '').trim();
}

export function classifyRuntimeFailure(error) {
  const message = normalizedMessage(error);
  if (/timed?\s*out|timeout|aborterror/i.test(message)) {
    return { retryable: true, code: 'timeout' };
  }
  if (/empty (?:response|output)|returned an empty/i.test(message)) {
    return { retryable: true, code: 'empty_response' };
  }
  if (/\b(?:ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|fetch failed)\b/i
    .test(message)) {
    return { retryable: true, code: 'network_failure' };
  }
  if (/process (?:exited|failed|terminated)|signal (?:SIG|9|15)|exit(?:ed)? with code/i
    .test(message)) {
    return { retryable: true, code: 'process_failure' };
  }
  return { retryable: false, code: 'non_runtime_failure' };
}

export function hasCredentialLikeText(value) {
  const text = String(value || '');
  return CREDENTIAL_PATTERNS.some(pattern => pattern.test(text));
}

export function evaluateCloudEligibility(input = {}) {
  const level = String(input.level || '').toUpperCase();
  if (!['L0', 'L1'].includes(level)) return { eligible: false, reason: 'risk_level' };
  if (Array.isArray(input.images) && input.images.some(Boolean)) {
    return { eligible: false, reason: 'image' };
  }
  if (Array.isArray(input.attachments) && input.attachments.some(Boolean)) {
    return { eligible: false, reason: 'attachment' };
  }
  if (input.pendingConfirmation === true) {
    return { eligible: false, reason: 'pending_confirmation' };
  }
  if (input.mutationIntent === true) return { eligible: false, reason: 'mutation_intent' };
  if (SENSITIVE_SOURCE_KINDS.has(String(input.sourceKind || '').toLowerCase())) {
    return { eligible: false, reason: 'sensitive_source' };
  }
  const prompt = String(input.prompt || '');
  if (hasCredentialLikeText(prompt)) return { eligible: false, reason: 'credential' };
  const maxPromptChars = Math.max(1, Number(input.maxPromptChars || 24_000));
  if (prompt.length > maxPromptChars) return { eligible: false, reason: 'prompt_too_large' };
  return { eligible: true, reason: 'eligible' };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactUrlQuery(match, base) {
  return `${base}?[REDACTED_QUERY]`;
}

export function sanitizeCloudPrompt(prompt, {
  forbiddenValues = [],
  ownerPhone = '',
  maxChars = 24_000,
} = {}) {
  const input = String(prompt || '');
  const maximum = Math.max(1, Number(maxChars || 24_000));
  if (input.length > maximum) {
    const error = new Error('Cloud prompt exceeds the configured character limit');
    error.code = 'cloud_prompt_too_large';
    throw error;
  }

  let text = input;
  text = text.replace(/(https?:\/\/[^\s?"'<>]+)\?[^\s"'<>]+/gi, redactUrlQuery);
  text = text.replace(/(?:\/Users|\/home|\/private|\/var\/folders)\/[^\s,，。；;：:)\]}>]+/g,
    '[REDACTED_LOCAL_PATH]');
  text = text.replace(/\b[A-Za-z]:\\(?:[^\s\\]+\\)*[^\s\\]+/g, '[REDACTED_LOCAL_PATH]');
  text = text.replace(/authorization\s*:\s*bearer\s+\S+/gi, 'Authorization: Bearer [REDACTED]');
  text = text.replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi,
    '[REDACTED_PRIVATE_KEY]');
  text = text.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_CREDENTIAL]');
  text = text.replace(/\b(?:access|refresh|api)[_-]?token\s*[:=]\s*["']?[A-Za-z0-9._-]{12,}/gi,
    '[REDACTED_CREDENTIAL]');

  for (const value of [ownerPhone, ...forbiddenValues]) {
    const secret = String(value || '').trim();
    if (!secret) continue;
    text = text.replace(new RegExp(escapeRegExp(secret), 'g'), '[REDACTED]');
  }

  if (text.length > maximum) {
    const error = new Error('Sanitized cloud prompt exceeds the configured character limit');
    error.code = 'cloud_prompt_too_large';
    throw error;
  }
  return {
    text,
    digest: createHash('sha256').update(text).digest('hex'),
    bytes: Buffer.byteLength(text, 'utf8'),
  };
}
