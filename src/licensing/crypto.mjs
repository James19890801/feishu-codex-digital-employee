import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from 'node:crypto';

const MAX_TOKEN_BYTES = 16 * 1024;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export class LicensingTokenError extends Error {
  constructor(message, code = 'invalid_token') {
    super(message);
    this.name = 'LicensingTokenError';
    this.code = code;
  }
}

function canonicalValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('expected a finite JSON number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalValue).join(',')}]`;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('unsupported JSON object type');
    }
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalValue(value[key])}`
    )).join(',')}}`;
  }
  throw new TypeError('unsupported JSON value');
}

export function canonicalJson(value) {
  return canonicalValue(value);
}

export function generateSigningKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'),
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
  };
}

function decodeKey(encoded, kind) {
  if (typeof encoded !== 'string' || !BASE64URL_PATTERN.test(encoded)) {
    throw new LicensingTokenError(`${kind} key is malformed`, 'invalid_key');
  }
  const der = Buffer.from(encoded, 'base64url');
  try {
    return kind === 'private'
      ? createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
      : createPublicKey({ key: der, format: 'der', type: 'spki' });
  } catch {
    throw new LicensingTokenError(`${kind} key is malformed`, 'invalid_key');
  }
}

export function publicKeyFingerprint(publicKey) {
  const key = decodeKey(publicKey, 'public');
  const der = key.export({ format: 'der', type: 'spki' });
  return `sha256:${createHash('sha256').update(der).digest('hex')}`;
}

export function signEnvelope(payload, privateKey) {
  const canonical = canonicalJson(payload);
  const body = Buffer.from(canonical, 'utf8');
  if (body.length > MAX_TOKEN_BYTES) {
    throw new LicensingTokenError('licensing payload is too large', 'token_too_large');
  }
  const signature = sign(null, body, decodeKey(privateKey, 'private'));
  return `${body.toString('base64url')}.${signature.toString('base64url')}`;
}

function decodePart(value, label) {
  if (!value || !BASE64URL_PATTERN.test(value)) {
    throw new LicensingTokenError(`licensing token is malformed (${label})`);
  }
  return Buffer.from(value, 'base64url');
}

export function verifyEnvelope(token, publicKey) {
  if (typeof token !== 'string') throw new LicensingTokenError('licensing token is malformed');
  if (Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES * 2) {
    throw new LicensingTokenError('licensing token is too large', 'token_too_large');
  }
  const parts = token.split('.');
  if (parts.length !== 2) throw new LicensingTokenError('licensing token is malformed');
  const body = decodePart(parts[0], 'body');
  const signature = decodePart(parts[1], 'signature');
  if (body.length > MAX_TOKEN_BYTES) {
    throw new LicensingTokenError('licensing token is too large', 'token_too_large');
  }
  if (!verify(null, body, decodeKey(publicKey, 'public'), signature)) {
    throw new LicensingTokenError('licensing token signature is invalid', 'invalid_signature');
  }
  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    throw new LicensingTokenError('licensing token payload is malformed');
  }
  if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
    throw new LicensingTokenError('licensing token payload is malformed');
  }
  if (canonicalJson(payload) !== body.toString('utf8')) {
    throw new LicensingTokenError('licensing token payload is not canonical');
  }
  return payload;
}

function validTime(value) {
  if (typeof value !== 'string') return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export function evaluateEntitlement(entitlement, {
  product,
  deviceKeyHash,
  now = new Date(),
} = {}) {
  if (!entitlement || typeof entitlement !== 'object' || Array.isArray(entitlement)) {
    return { valid: false, reason: 'invalid_entitlement' };
  }
  if (entitlement.product !== product) return { valid: false, reason: 'wrong_product' };
  if (entitlement.deviceKeyHash !== deviceKeyHash) return { valid: false, reason: 'wrong_device' };
  const notBefore = validTime(entitlement.notBefore);
  const expiresAt = validTime(entitlement.expiresAt);
  const current = now instanceof Date ? now.getTime() : Number(now);
  if (notBefore === null || expiresAt === null || !Number.isFinite(current)) {
    return { valid: false, reason: 'invalid_time' };
  }
  if (current < notBefore) return { valid: false, reason: 'not_yet_valid' };
  if (current > expiresAt) return { valid: false, reason: 'expired' };
  return { valid: true, reason: 'valid' };
}
