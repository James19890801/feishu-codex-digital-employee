import { timingSafeEqual } from 'node:crypto';

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

export function isAllowedDashboardAction({
  host,
  origin,
  action,
  expectedAction,
  token,
  expectedToken,
  allowedHosts,
}) {
  if (!allowedHosts?.has(host)) return false;
  let originHost = '';
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== 'http:') return false;
    originHost = parsed.host;
  } catch {
    return false;
  }
  return allowedHosts.has(originHost)
    && action === expectedAction
    && safeEqual(token, expectedToken);
}

export function parseDashboardJson(text, { maxBytes = 64 * 1024 } = {}) {
  const source = String(text || '');
  if (Buffer.byteLength(source, 'utf8') > maxBytes) {
    throw new Error('Dashboard request body is too large');
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error('Dashboard request contains invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Dashboard request body must be a JSON object');
  }
  return parsed;
}
