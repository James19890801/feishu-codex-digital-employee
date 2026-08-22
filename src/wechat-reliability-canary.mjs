import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export const CANARY_PATH = '/internal/reliability/canary';
export const CANARY_VALIDITY_MS = 60_000;

function assertSecret(secret) {
  const value = String(secret || '');
  if (value.length < 32 || value.length > 256) {
    throw new Error('Canary secret must contain 32 to 256 characters');
  }
  return value;
}

function assertNonce(nonce) {
  const value = String(nonce || '');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new Error('Canary nonce must contain 1 to 128 URL-safe characters');
  }
  return value;
}

function signatureFor({ secret, timestamp, nonce }) {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${nonce}`)
    .digest('hex');
}

export function createCanaryChallenge({
  secret,
  nowMs = Date.now(),
  nonce = randomBytes(24).toString('base64url'),
}) {
  const safeSecret = assertSecret(secret);
  const safeNonce = assertNonce(nonce);
  const timestamp = String(Math.trunc(Number(nowMs)));
  if (!/^-?\d+$/.test(timestamp)) throw new Error('Canary timestamp must be finite');
  return {
    timestamp,
    nonce: safeNonce,
    signature: signatureFor({ secret: safeSecret, timestamp, nonce: safeNonce }),
  };
}

export function verifyCanaryChallenge(challenge, {
  secret,
  nowMs = Date.now(),
  validityMs = CANARY_VALIDITY_MS,
}) {
  let safeSecret;
  try {
    safeSecret = assertSecret(secret);
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const timestamp = String(challenge?.timestamp || '');
  const nonce = String(challenge?.nonce || '');
  const signature = String(challenge?.signature || '');
  if (!/^-?\d{1,16}$/.test(timestamp)
    || !/^[A-Za-z0-9_-]{1,128}$/.test(nonce)
    || !/^[a-f0-9]{64}$/.test(signature)) {
    return { ok: false, reason: 'malformed' };
  }
  const challengeTimeMs = Number(timestamp);
  const currentTimeMs = Number(nowMs);
  const maximumAgeMs = Math.max(1, Math.min(Number(validityMs) || 0, CANARY_VALIDITY_MS));
  if (!Number.isSafeInteger(challengeTimeMs) || !Number.isFinite(currentTimeMs)) {
    return { ok: false, reason: 'malformed' };
  }
  if (currentTimeMs - challengeTimeMs > maximumAgeMs) {
    return { ok: false, reason: 'expired' };
  }
  if (challengeTimeMs - currentTimeMs > maximumAgeMs) {
    return { ok: false, reason: 'not_yet_valid' };
  }
  const expected = Buffer.from(signatureFor({ secret: safeSecret, timestamp, nonce }), 'hex');
  const actual = Buffer.from(signature, 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'invalid_signature' };
  }
  return { ok: true };
}

export function createCanaryResponse(challenge, { nowMs = Date.now() } = {}) {
  return {
    ok: true,
    nonceDigest: createHash('sha256').update(String(challenge?.nonce || '')).digest('hex'),
    at: new Date(Number(nowMs)).toISOString(),
  };
}
