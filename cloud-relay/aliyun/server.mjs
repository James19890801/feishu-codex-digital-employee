import { createServer } from 'node:http';
import {
  artifactKeyFromPath,
  authorizeBearer,
  callbackPathMatches,
  digestBytes,
  verifyCanaryRequest,
} from '../worker/src/contract.mjs';

const MAX_WEBHOOK_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
const MAX_PARITY_BYTES = 24 * 1024 * 1024 + 4096;

function reply(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(payload));
}

async function readBody(request, maximum) {
  const declared = Number(request.headers['content-length'] || 0);
  if (declared > maximum) throw Object.assign(new Error('body_too_large'), { status: 413 });
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maximum) throw Object.assign(new Error('body_too_large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function readJson(request, maximum = MAX_WEBHOOK_BYTES) {
  const bytes = await readBody(request, maximum);
  return JSON.parse(bytes.toString('utf8'));
}

export function createRelayServer({ store, callbackSecret, relayToken, artifactToken, canarySecret,
  parityToken, controlToken, now = Date.now }) {
  if (!store || !callbackSecret || !relayToken || !artifactToken || !canarySecret) {
    throw new Error('Relay configuration is incomplete');
  }
  return createServer(async (request, response) => {
    const url = new URL(request.url, 'http://localhost');
    try {
      if (request.method === 'GET' && url.pathname === '/healthz') {
        return reply(response, 200, { ok: true, service: 'aipro-wechat-relay' });
      }
      if (url.pathname.startsWith('/control/')) {
        if (!controlToken) return reply(response, 404, { ok: false });
        if (!authorizeBearer(request.headers.authorization, controlToken)) {
          return reply(response, 401, { ok: false });
        }
        if (request.method === 'GET' && url.pathname === '/control/status') {
          const current = store.leadershipStatus();
          return reply(response, 200, { ok: true, state: current?.state || 'DISABLED',
            owner: current?.owner || null, generation: current?.generation || 0,
            heartbeatAgeMs: current ? Math.max(0, now() - current.heartbeatAt) : null });
        }
        const action = new Map([
          ['/control/heartbeat', 'heartbeatLocal'],
          ['/control/claim', 'claimEvent'],
          ['/control/intent', 'prepareSend'],
          ['/control/receipt', 'recordSendReceipt'],
          ['/control/complete', 'completeClaim'],
        ]).get(url.pathname);
        if (request.method !== 'POST' || !action) return reply(response, 404, { ok: false });
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
          return reply(response, 415, { ok: false, error: 'unsupported_media_type' });
        }
        let input;
        try { input = await readJson(request, 4096); } catch (error) {
          return reply(response, error?.status || 400, { ok: false, error: error?.status === 413
            ? 'body_too_large' : 'invalid_json' });
        }
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          return reply(response, 400, { ok: false, error: 'invalid_control' });
        }
        try {
          const result = store[action]({ ...input, worker: 'mac', now: now() });
          return reply(response, 200, { ok: true, ...result });
        } catch {
          return reply(response, 400, { ok: false, error: 'invalid_control' });
        }
      }
      if (url.pathname.startsWith('/parity/')) {
        if (!parityToken) return reply(response, 404, { ok: false });
        if (!authorizeBearer(request.headers.authorization, parityToken)) {
          return reply(response, 401, { ok: false });
        }
        if (request.method === 'GET' && url.pathname === '/parity/status') {
          const current = store.getCurrentPolicy();
          const cursor = store.getPolicyCursor(url.searchParams.get('workerId') || 'mac');
          return reply(response, 200, { ok: true, revision: current?.revision || 0,
            digest: current?.digest || null, workerSequence: cursor?.sequence || 0 });
        }
        if (request.method === 'PUT' && url.pathname === '/parity/snapshot') {
          if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
            return reply(response, 415, { ok: false, error: 'unsupported_media_type' });
          }
          let input;
          try { input = await readJson(request, MAX_PARITY_BYTES); } catch (error) {
            return reply(response, error?.status || 400, { ok: false, error: error?.status === 413
              ? 'body_too_large' : 'invalid_json' });
          }
          try {
            const result = store.savePolicySnapshot({ workerId: input.workerId,
              sequence: input.sequence, manifest: input.manifest, now: now() });
            return reply(response, 200, { ok: true, ...result });
          } catch (error) {
            const conflict = /stale|digest_mismatch/.test(error?.message || '');
            return reply(response, conflict ? 409 : 400, { ok: false,
              error: conflict ? 'policy_conflict' : 'invalid_policy' });
          }
        }
        return reply(response, 404, { ok: false });
      }
      if (request.method === 'GET' && url.pathname === '/internal/reliability/canary') {
        const result = await verifyCanaryRequest(Object.fromEntries(url.searchParams), {
          secret: canarySecret, nowMs: now(),
        });
        return reply(response, result.ok ? 200 : 404, result.ok ? result.response : { ok: false });
      }
      if (request.method === 'POST' && callbackPathMatches(url.pathname, callbackSecret)) {
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
          return reply(response, 415, { ok: false, error: 'unsupported_media_type' });
        }
        const bytes = await readBody(request, MAX_WEBHOOK_BYTES);
        const body = bytes.toString('utf8');
        try { JSON.parse(body); } catch { return reply(response, 400, { ok: false, error: 'invalid_json' }); }
        const result = await store.enqueue({ digest: await digestBytes(bytes), body, createdAt: now() });
        return reply(response, 200, { ok: true, ...result });
      }
      if (url.pathname === '/relay/lease' && request.method === 'POST') {
        if (!authorizeBearer(request.headers.authorization, relayToken)) return reply(response, 401, { ok: false });
        const input = await readJson(request).catch(() => ({}));
        return reply(response, 200, await store.lease({ ...input, now: now() }));
      }
      if (url.pathname === '/relay/ack' && request.method === 'POST') {
        if (!authorizeBearer(request.headers.authorization, relayToken)) return reply(response, 401, { ok: false });
        const input = await readJson(request).catch(() => ({}));
        return reply(response, 200, await store.ack(input));
      }
      if (url.pathname === '/relay/status' && request.method === 'GET') {
        if (!authorizeBearer(request.headers.authorization, relayToken)) return reply(response, 401, { ok: false });
        return reply(response, 200, await store.status({ now: now() }));
      }
      if (url.pathname.startsWith('/relay/artifacts/') && request.method === 'PUT') {
        if (!authorizeBearer(request.headers.authorization, artifactToken)) return reply(response, 401, { ok: false });
        const match = url.pathname.match(/^\/relay\/artifacts\/([A-Za-z0-9_-]{24,128})\/([^/]{1,240})$/);
        if (!match) return reply(response, 404, { ok: false });
        const bytes = await readBody(request, MAX_ARTIFACT_BYTES);
        if (!bytes.length) return reply(response, 413, { ok: false, error: 'body_too_large' });
        const requestedTtl = Number(url.searchParams.get('ttl'));
        const ttl = Number.isInteger(requestedTtl) && requestedTtl >= 30 && requestedTtl <= 900 ? requestedTtl : 300;
        const expiresAt = now() + ttl * 1000;
        const fileName = decodeURIComponent(match[2]).slice(0, 180);
        await store.putArtifact(match[1], {
          bytes,
          expiresAt,
          fileName,
          contentType: request.headers['content-type'] || 'application/octet-stream',
        });
        return reply(response, 201, {
          ok: true,
          publicPath: `/webhooks/gewe/${callbackSecret}/artifacts/${match[1]}/${match[2]}`,
          expiresAt,
        });
      }
      const artifactKey = artifactKeyFromPath(url.pathname, callbackSecret);
      if (artifactKey && (request.method === 'GET' || request.method === 'HEAD')) {
        const object = await store.getArtifact(artifactKey);
        if (!object || Number(object.expiresAt) <= now()) return reply(response, 404, { ok: false });
        response.writeHead(200, {
          'content-type': object.contentType || 'application/octet-stream',
          'content-disposition': `attachment; filename="artifact"; filename*=UTF-8''${encodeURIComponent(object.fileName || 'artifact')}`,
          'content-length': object.bytes.length,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        return response.end(request.method === 'HEAD' ? undefined : object.bytes);
      }
      return reply(response, 404, { ok: false });
    } catch (error) {
      return reply(response, error?.status || 503, { ok: false, error: error?.status === 413 ? 'body_too_large' : 'storage_unavailable' });
    }
  });
}
