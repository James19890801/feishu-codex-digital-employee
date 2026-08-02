import {
  canonicalJson,
  LicensingTokenError,
  signEnvelope,
  verifyEnvelope,
} from '../../../src/licensing/crypto.mjs';
import { D1LicensingRepository } from './repository-d1.mjs';
import { DomainError, InvitationService } from './domain.mjs';

const JSON_TYPE = 'application/json';
const MAX_BODY_BYTES = 16 * 1024;
const DEVICE_KEY_HASH = /^sha256:[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-z0-9][a-z0-9-]{2,79}$/;

function randomToken(bytes = 24) {
  const values = new Uint8Array(bytes);
  crypto.getRandomValues(values);
  return Buffer.from(values).toString('base64url');
}

export async function keyedDigest(value, pepper) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(pepper),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function jsonResponse(status, payload, requestId, extraHeaders = {}) {
  return new Response(JSON.stringify({ ...payload, requestId }), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-request-id': requestId,
      ...extraHeaders,
    },
  });
}

function assertExactKeys(value, allowed, required = allowed) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new DomainError('invalid_request', 'Invalid request.');
  }
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !(key in value))) {
    throw new DomainError('invalid_request', 'Invalid request.');
  }
}

async function readJson(request) {
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith(JSON_TYPE)) {
    throw new DomainError('unsupported_media_type', 'Content-Type must be application/json.');
  }
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BODY_BYTES) throw new DomainError('payload_too_large', 'Request is too large.');
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    throw new DomainError('payload_too_large', 'Request is too large.');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new DomainError('invalid_request', 'Invalid request.');
  }
}

function statusForError(error) {
  if (error?.code === 'unsupported_media_type') return 415;
  if (error?.code === 'payload_too_large') return 413;
  if (error?.code === 'rate_limited') return 429;
  if (error?.code === 'issuer_authorization_failed'
    || error?.code === 'recovery_failed'
    || error instanceof LicensingTokenError) return 403;
  if (error instanceof DomainError) return 400;
  return 500;
}

function publicError(error) {
  if (error?.code === 'rate_limited') return { code: 'rate_limited', message: 'Try again later.' };
  if (error?.code === 'invalid_invitation') {
    return { code: 'invalid_invitation', message: 'Invitation code cannot be used.' };
  }
  if (error?.code === 'unsupported_media_type') {
    return { code: 'unsupported_media_type', message: error.message };
  }
  if (error?.code === 'payload_too_large') return { code: 'payload_too_large', message: error.message };
  if (error?.code === 'issuer_authorization_failed' || error instanceof LicensingTokenError) {
    return { code: 'issuer_authorization_failed', message: 'Issuer authorization failed.' };
  }
  if (error?.code === 'recovery_failed') {
    return { code: 'recovery_failed', message: 'Founder recovery failed.' };
  }
  if (error instanceof DomainError) return { code: 'invalid_request', message: 'Invalid request.' };
  return { code: 'internal_error', message: 'Licensing service error.' };
}

function requireEnv(env) {
  for (const key of [
    'INVITATION_HASH_PEPPER',
    'RECOVERY_HASH_PEPPER',
    'LICENSE_SIGNING_PRIVATE_KEY',
  ]) {
    if (typeof env[key] !== 'string' || env[key].length < 16) {
      throw new Error(`missing required Worker secret ${key}`);
    }
  }
}

function createDomain(repository, env, now) {
  return new InvitationService({
    repository,
    pepper: env.INVITATION_HASH_PEPPER,
    now,
    issueEntitlement: async payload => ({
      token: signEnvelope(payload, env.LICENSE_SIGNING_PRIVATE_KEY),
      payload,
    }),
  });
}

function issuerFailure() {
  return new DomainError('issuer_authorization_failed', 'Issuer authorization failed.');
}

async function authorizeIssuer({ repository, env, issuerId, proof, request, action, now }) {
  const issuer = await repository.getIssuer(issuerId);
  if (!issuer || issuer.status !== 'active' || !issuer.roles?.includes(action)) throw issuerFailure();
  let payload;
  try {
    payload = verifyEnvelope(proof, issuer.publicKey);
  } catch {
    throw issuerFailure();
  }
  const expected = {
    version: 1,
    action,
    issuerId,
    challengeId: payload.challengeId,
    nonce: payload.nonce,
    request,
  };
  if (canonicalJson(payload) !== canonicalJson(expected)) throw issuerFailure();
  const nonceHash = await keyedDigest(payload.nonce, env.INVITATION_HASH_PEPPER);
  const consumed = await repository.consumeIssuerChallenge({
    id: payload.challengeId,
    issuerId,
    nonceHash,
    now,
  });
  if (!consumed) throw issuerFailure();
  return issuer;
}

function methodNotAllowed(allow, requestId) {
  return jsonResponse(405, {
    ok: false,
    error: { code: 'method_not_allowed', message: 'Method not allowed.' },
  }, requestId, { allow });
}

export function createWorker({
  repository,
  repositoryFactory = env => new D1LicensingRepository(env.DB),
  now = () => Date.now(),
} = {}) {
  return {
    async fetch(request, env) {
      const requestId = `req_${crypto.randomUUID()}`;
      try {
        requireEnv(env);
        const storage = repository || repositoryFactory(env);
        const url = new URL(request.url);
        const timestamp = now();

        if (url.pathname === '/v1/contact-card') {
          if (request.method !== 'GET') return methodNotAllowed('GET', requestId);
          const object = await env.CONTACT_CARDS?.get(
            String(env.CONTACT_CARD_KEY || 'james-wechat.jpg'),
          );
          const contentType = String(object?.httpMetadata?.contentType || '');
          if (!object
            || Number(object.size || 0) > 2 * 1024 * 1024
            || !['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
            return jsonResponse(404, {
              ok: false,
              error: { code: 'not_found', message: 'Not found.' },
            }, requestId);
          }
          return new Response(object.body, {
            status: 200,
            headers: {
              'content-type': contentType,
              'content-length': String(object.size),
              'cache-control': 'public, max-age=3600',
              'x-content-type-options': 'nosniff',
              'referrer-policy': 'no-referrer',
              'x-request-id': requestId,
            },
          });
        }

        if (url.pathname === '/v1/health') {
          if (request.method !== 'GET') return methodNotAllowed('GET', requestId);
          return jsonResponse(200, { ok: true, service: 'aipro-licensing' }, requestId);
        }

        if (url.pathname === '/v1/activate') {
          if (request.method !== 'POST') return methodNotAllowed('POST', requestId);
          const body = await readJson(request);
          assertExactKeys(body, ['code', 'deviceKeyHash', 'installId']);
          const activationKey = await keyedDigest(
            `${request.headers.get('cf-connecting-ip') || 'unknown'}|${body.installId || ''}`,
            env.INVITATION_HASH_PEPPER,
          );
          const activated = await createDomain(storage, env, now).activate({
            code: body.code,
            deviceKeyHash: body.deviceKeyHash,
            activationKey,
          });
          return jsonResponse(200, { ok: true, entitlement: activated.entitlement }, requestId);
        }

        if (url.pathname === '/v1/issuer/challenge') {
          if (request.method !== 'POST') return methodNotAllowed('POST', requestId);
          const body = await readJson(request);
          assertExactKeys(body, ['issuerId']);
          const issuer = await storage.getIssuer(body.issuerId);
          if (!issuer || issuer.status !== 'active' || !issuer.roles?.includes('invite.issue')) {
            throw issuerFailure();
          }
          const nonce = randomToken(32);
          const challenge = {
            id: `challenge_${crypto.randomUUID()}`,
            issuerId: issuer.id,
            nonceHash: await keyedDigest(nonce, env.INVITATION_HASH_PEPPER),
            createdAt: new Date(timestamp).toISOString(),
            expiresAt: new Date(timestamp + 5 * 60 * 1000).toISOString(),
          };
          await storage.createIssuerChallenge(challenge);
          return jsonResponse(200, {
            ok: true,
            challenge: { id: challenge.id, nonce, expiresAt: challenge.expiresAt },
          }, requestId);
        }

        if (url.pathname === '/v1/issuer/invites') {
          if (request.method !== 'POST') return methodNotAllowed('POST', requestId);
          const body = await readJson(request);
          assertExactKeys(body, ['issuerId', 'proof', 'request']);
          assertExactKeys(
            body.request,
            ['invitationDays', 'licenseDays', 'customerNote'],
            [],
          );
          await authorizeIssuer({
            repository: storage,
            env,
            issuerId: body.issuerId,
            proof: body.proof,
            request: body.request,
            action: 'invite.issue',
            now: timestamp,
          });
          const batch = await createDomain(storage, env, now).generateBatch({
            issuerId: body.issuerId,
            count: 10,
            ...body.request,
          });
          return jsonResponse(201, { ok: true, batch }, requestId);
        }

        if (url.pathname === '/v1/founder/recover') {
          if (request.method !== 'POST') return methodNotAllowed('POST', requestId);
          const body = await readJson(request);
          assertExactKeys(body, [
            'recoveryId', 'recoverySecret', 'holder', 'newIssuer', 'deviceKeyHash',
          ]);
          assertExactKeys(body.newIssuer, ['id', 'displayName', 'publicKey']);
          if (!IDENTIFIER.test(body.holder)
            || !IDENTIFIER.test(body.newIssuer.id)
            || typeof body.newIssuer.displayName !== 'string'
            || body.newIssuer.displayName.length < 2
            || body.newIssuer.displayName.length > 80
            || typeof body.newIssuer.publicKey !== 'string'
            || !DEVICE_KEY_HASH.test(body.deviceKeyHash)
            || typeof body.recoverySecret !== 'string'
            || body.recoverySecret.length < 24
            || body.recoverySecret.length > 256) {
            throw new DomainError('recovery_failed', 'Founder recovery failed.');
          }
          const replacementSecret = randomToken(36);
          const replacementRecovery = {
            id: `recovery_${crypto.randomUUID()}`,
            holder: body.holder,
            secretHash: await keyedDigest(replacementSecret, env.RECOVERY_HASH_PEPPER),
            generation: 0,
            status: 'active',
            createdAt: new Date(timestamp).toISOString(),
          };
          const newIssuer = {
            ...body.newIssuer,
            holder: body.holder,
            roles: ['invite.issue', 'invite.revoke'],
            status: 'active',
            createdAt: new Date(timestamp).toISOString(),
          };
          const recovered = await storage.consumeRecoveryCredential({
            id: body.recoveryId,
            secretHash: await keyedDigest(body.recoverySecret, env.RECOVERY_HASH_PEPPER),
            holder: body.holder,
            newIssuer,
            replacementRecovery,
            now: timestamp,
          });
          if (!recovered) throw new DomainError('recovery_failed', 'Founder recovery failed.');
          const founder = {
            version: 1,
            product: 'AIPRO',
            licenseId: `license_${crypto.randomUUID()}`,
            edition: 'Founder',
            issuerId: newIssuer.id,
            deviceKeyHash: body.deviceKeyHash,
            notBefore: new Date(timestamp).toISOString(),
            expiresAt: new Date(timestamp + (100 * 365 * 24 * 60 * 60 * 1000)).toISOString(),
          };
          return jsonResponse(200, {
            ok: true,
            issuer: { id: newIssuer.id, displayName: newIssuer.displayName },
            entitlement: signEnvelope(founder, env.LICENSE_SIGNING_PRIVATE_KEY),
            recoveryKit: { id: replacementRecovery.id, secret: replacementSecret },
          }, requestId);
        }

        return jsonResponse(404, {
          ok: false,
          error: { code: 'not_found', message: 'Not found.' },
        }, requestId);
      } catch (error) {
        const status = statusForError(error);
        return jsonResponse(status, {
          ok: false,
          error: publicError(error),
        }, requestId, error?.retryAfterSeconds
          ? { 'retry-after': String(error.retryAfterSeconds) }
          : {});
      }
    },
  };
}

export default createWorker();
