const encoder = new TextEncoder();

function equalText(left, right) {
  const a = encoder.encode(String(left || ''));
  const b = encoder.encode(String(right || ''));
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function digestBytes(bytes) {
  return hex(await crypto.subtle.digest('SHA-256', bytes));
}

export function callbackPathMatches(pathname, secret) {
  return equalText(String(pathname || ''), `/webhooks/gewe/${String(secret || '')}`);
}

export function authorizeBearer(header, secret) {
  const expected = `Bearer ${String(secret || '')}`;
  return String(secret || '').length >= 24 && equalText(String(header || ''), expected);
}

export function artifactKeyFromPath(pathname, callbackSecret) {
  const prefix = `/webhooks/gewe/${String(callbackSecret || '')}/artifacts/`;
  if (!String(pathname || '').startsWith(prefix)) return null;
  const remainder = String(pathname).slice(prefix.length);
  const [key, fileName, ...extra] = remainder.split('/');
  if (extra.length || !fileName || !/^[A-Za-z0-9_-]{24,128}$/.test(key)) return null;
  return key;
}

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

export async function verifyCanaryRequest(challenge, {
  secret,
  nowMs = Date.now(),
  validityMs = 60_000,
} = {}) {
  const safeSecret = String(secret || '');
  const timestamp = String(challenge?.timestamp || '');
  const nonce = String(challenge?.nonce || '');
  const signature = String(challenge?.signature || '');
  if (safeSecret.length < 32 || safeSecret.length > 256
    || !/^-?\d{1,16}$/.test(timestamp)
    || !/^[A-Za-z0-9_-]{1,128}$/.test(nonce)
    || !/^[a-f0-9]{64}$/.test(signature)) return { ok: false, reason: 'malformed' };
  const challengeTimeMs = Number(timestamp);
  if (!Number.isSafeInteger(challengeTimeMs) || !Number.isFinite(Number(nowMs))) {
    return { ok: false, reason: 'malformed' };
  }
  const maximumAgeMs = Math.max(1, Math.min(Number(validityMs) || 0, 60_000));
  if (Number(nowMs) - challengeTimeMs > maximumAgeMs) return { ok: false, reason: 'expired' };
  if (challengeTimeMs - Number(nowMs) > maximumAgeMs) return { ok: false, reason: 'not_yet_valid' };
  const expected = await hmacHex(safeSecret, `${timestamp}.${nonce}`);
  if (!equalText(expected, signature)) return { ok: false, reason: 'invalid_signature' };
  return {
    ok: true,
    response: {
      ok: true,
      nonceDigest: await digestBytes(encoder.encode(nonce)),
      at: new Date(Number(nowMs)).toISOString(),
    },
  };
}
