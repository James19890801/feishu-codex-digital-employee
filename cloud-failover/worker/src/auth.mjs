const encoder = new TextEncoder();

async function hexDigest(algorithm, value) {
  const digest = await crypto.subtle.digest(algorithm, encoder.encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function equalHex(left, right) {
  const a = String(left || '').toLowerCase();
  const b = String(right || '').toLowerCase();
  if (a.length !== b.length || !/^[a-f0-9]+$/.test(a + b)) return false;
  let different = 0;
  for (let index = 0; index < a.length; index += 1) different |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return different === 0;
}

export class InMemoryReplayStore {
  constructor() { this.nonces = new Map(); }
  async use(node, nonce, expiresAt, now) {
    for (const [key, expiry] of this.nonces) if (expiry <= now) this.nonces.delete(key);
    const key = `${node}:${nonce}`;
    if (this.nonces.has(key)) return false;
    this.nonces.set(key, expiresAt);
    return true;
  }
}

export async function verifySignedRequest(request, env, replayStore, now = Date.now()) {
  const node = request.headers.get('x-aipros-node') || '';
  const timestamp = Number(request.headers.get('x-aipros-timestamp'));
  const nonce = request.headers.get('x-aipros-nonce') || '';
  const suppliedHash = request.headers.get('x-aipros-content-sha256') || '';
  const suppliedSignature = request.headers.get('x-aipros-signature') || '';
  if (node !== String(env.AIPROS_NODE_ID || '')) throw Object.assign(new Error('Unknown node'), { code: 'unknown_node' });
  if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > 90_000) {
    throw Object.assign(new Error('Expired request'), { code: 'request_expired' });
  }
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(nonce)) throw Object.assign(new Error('Invalid nonce'), { code: 'invalid_nonce' });
  const body = await request.clone().text();
  const contentHash = await hexDigest('SHA-256', body);
  if (!equalHex(contentHash, suppliedHash)) throw Object.assign(new Error('Body hash mismatch'), { code: 'body_tampered' });
  const path = new URL(request.url).pathname;
  const canonical = [request.method.toUpperCase(), path, timestamp, nonce, contentHash].join('\n');
  const key = await crypto.subtle.importKey('raw', encoder.encode(String(env.AIPROS_HMAC_SECRET || '')),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(canonical));
  const expected = [...new Uint8Array(signed)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (!equalHex(expected, suppliedSignature)) throw Object.assign(new Error('Invalid signature'), { code: 'invalid_signature' });
  if (!await replayStore.use(node, nonce, timestamp + 90_001, now)) {
    throw Object.assign(new Error('Replayed request'), { code: 'nonce_replayed' });
  }
  return { node, body };
}
