import {
  artifactKeyFromPath,
  authorizeBearer,
  callbackPathMatches,
  digestBytes,
  verifyCanaryRequest,
} from './contract.mjs';

const MAX_WEBHOOK_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
const encoder = new TextEncoder();

function json(payload, status = 200, extra = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extra,
    },
  });
}

function coordinator(env) {
  if (typeof env.RELAY_COORDINATOR?.getByName === 'function') {
    return env.RELAY_COORDINATOR.getByName('primary');
  }
  const id = env.RELAY_COORDINATOR.idFromName('primary');
  return env.RELAY_COORDINATOR.get(id);
}

async function bodyText(request, limit) {
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > limit) throw Object.assign(new Error('body_too_large'), { status: 413 });
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > limit) throw Object.assign(new Error('body_too_large'), { status: 413 });
  return { bytes, text: new TextDecoder().decode(bytes) };
}

function safeInteger(value, fallback, min, max) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= min && numeric <= max ? numeric : fallback;
}

export class RelayCoordinatorCore {
  constructor(ctx) {
    if (!ctx?.storage) throw new TypeError('Durable Object storage is required');
    this.storage = ctx.storage;
  }

  async enqueue(input) {
    const digest = String(input?.digest || '');
    const body = String(input?.body || '');
    const createdAt = Number(input?.createdAt);
    if (!/^[a-f0-9]{64}$/.test(digest) || !body || body.length > MAX_WEBHOOK_BYTES || !Number.isFinite(createdAt)) {
      throw new Error('invalid_event');
    }
    return this.storage.transaction(async transaction => {
      const key = `event:${digest}`;
      if (await transaction.get(key)) return { accepted: true, duplicate: true };
      await transaction.put(key, { digest, body, createdAt, leaseUntil: 0, attempts: 0 });
      return { accepted: true, duplicate: false };
    });
  }

  async lease(input = {}) {
    const now = Number(input.now) || Date.now();
    const leaseMs = safeInteger(input.leaseMs, 30_000, 5_000, 300_000);
    const limit = safeInteger(input.limit, 10, 1, 50);
    return this.storage.transaction(async transaction => {
      const records = [...(await transaction.list({ prefix: 'event:' })).values()]
        .filter(record => Number(record.leaseUntil || 0) <= now)
        .sort((left, right) => Number(left.createdAt) - Number(right.createdAt))
        .slice(0, limit);
      for (const record of records) {
        record.leaseUntil = now + leaseMs;
        record.attempts = Number(record.attempts || 0) + 1;
        await transaction.put(`event:${record.digest}`, record);
      }
      return { events: records.map(record => ({
        id: record.digest,
        body: record.body,
        createdAt: record.createdAt,
        leaseUntil: record.leaseUntil,
        attempts: record.attempts,
      })) };
    });
  }

  async ack(input = {}) {
    const ids = [...new Set(Array.isArray(input.ids) ? input.ids.map(String) : [])]
      .filter(id => /^[a-f0-9]{64}$/.test(id)).slice(0, 50);
    let acked = 0;
    await this.storage.transaction(async transaction => {
      for (const id of ids) if (await transaction.delete(`event:${id}`)) acked += 1;
    });
    return { acked };
  }

  async status(input = {}) {
    const now = Number(input.now) || Date.now();
    const records = [...(await this.storage.list({ prefix: 'event:' })).values()];
    const leased = records.filter(record => Number(record.leaseUntil || 0) > now).length;
    return { pending: records.length - leased, leased, total: records.length };
  }
}

export function createRelayWorker({ now = Date.now } = {}) {
  return {
    async fetch(request, env, ctx = {}) {
      const url = new URL(request.url);
      try {
        if (request.method === 'GET' && url.pathname === '/healthz') {
          return json({ ok: true, service: 'aipro-wechat-relay' });
        }
        if (request.method === 'GET' && url.pathname === '/internal/reliability/canary') {
          const verified = await verifyCanaryRequest(Object.fromEntries(url.searchParams), {
            secret: env.CANARY_SECRET,
            nowMs: now(),
          });
          return verified.ok ? json(verified.response) : json({ ok: false }, 404);
        }
        if (request.method === 'POST' && callbackPathMatches(url.pathname, env.CALLBACK_SECRET)) {
          if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) {
            return json({ ok: false, error: 'unsupported_media_type' }, 415);
          }
          const body = await bodyText(request, MAX_WEBHOOK_BYTES);
          try { JSON.parse(body.text); } catch { return json({ ok: false, error: 'invalid_json' }, 400); }
          const result = await coordinator(env).enqueue({
            digest: await digestBytes(body.bytes),
            body: body.text,
            createdAt: now(),
          });
          return json({ ok: true, ...result }, 200);
        }
        if (url.pathname === '/relay/lease' && request.method === 'POST') {
          if (!authorizeBearer(request.headers.get('authorization'), env.RELAY_TOKEN)) return json({ ok: false }, 401);
          const input = await request.json().catch(() => ({}));
          return json(await coordinator(env).lease({ ...input, now: now() }));
        }
        if (url.pathname === '/relay/ack' && request.method === 'POST') {
          if (!authorizeBearer(request.headers.get('authorization'), env.RELAY_TOKEN)) return json({ ok: false }, 401);
          return json(await coordinator(env).ack(await request.json().catch(() => ({}))));
        }
        if (url.pathname === '/relay/status' && request.method === 'GET') {
          if (!authorizeBearer(request.headers.get('authorization'), env.RELAY_TOKEN)) return json({ ok: false }, 401);
          return json(await coordinator(env).status({ now: now() }));
        }
        if (url.pathname.startsWith('/relay/artifacts/') && request.method === 'PUT') {
          if (!authorizeBearer(request.headers.get('authorization'), env.ARTIFACT_TOKEN)) return json({ ok: false }, 401);
          const match = url.pathname.match(/^\/relay\/artifacts\/([A-Za-z0-9_-]{24,128})\/([^/]{1,240})$/);
          if (!match) return json({ ok: false }, 404);
          const declared = Number(request.headers.get('content-length') || 0);
          if (declared > MAX_ARTIFACT_BYTES) return json({ ok: false, error: 'body_too_large' }, 413);
          const artifactBody = await request.arrayBuffer();
          if (!artifactBody.byteLength || artifactBody.byteLength > MAX_ARTIFACT_BYTES) {
            return json({ ok: false, error: 'body_too_large' }, 413);
          }
          const ttl = safeInteger(url.searchParams.get('ttl'), 300, 30, 900);
          const expiresAt = now() + ttl * 1_000;
          const key = `artifact/${match[1]}`;
          await env.ARTIFACTS_KV.put(key, artifactBody, {
            expirationTtl: ttl,
            metadata: {
              expiresAt,
              fileName: decodeURIComponent(match[2]).slice(0, 180),
              contentType: request.headers.get('content-type') || 'application/octet-stream',
            },
          });
          return json({
            ok: true,
            publicPath: `/webhooks/gewe/${env.CALLBACK_SECRET}/artifacts/${match[1]}/${match[2]}`,
            expiresAt,
          }, 201);
        }
        const artifactKey = artifactKeyFromPath(url.pathname, env.CALLBACK_SECRET);
        if (artifactKey && ['GET', 'HEAD'].includes(request.method)) {
          const key = `artifact/${artifactKey}`;
          const object = await env.ARTIFACTS_KV.getWithMetadata(key, 'arrayBuffer');
          if (!object) return json({ ok: false }, 404);
          if (Number(object.metadata?.expiresAt || 0) <= now()) {
            ctx.waitUntil?.(env.ARTIFACTS_KV.delete(key));
            return json({ ok: false }, 404);
          }
          const headers = new Headers({
            'content-type': object.metadata?.contentType || 'application/octet-stream',
            'content-disposition': `attachment; filename="artifact"; filename*=UTF-8''${encodeURIComponent(object.metadata?.fileName || 'artifact')}`,
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          });
          return new Response(request.method === 'HEAD' ? null : object.value, { status: 200, headers });
        }
        return json({ ok: false }, 404);
      } catch (error) {
        console.error('[wechat-relay]', error?.stack || error?.message || 'unknown error');
        return json({ ok: false, error: error?.message === 'body_too_large' ? 'body_too_large' : 'internal_error' }, error?.status || 500);
      }
    },
  };
}

export default createRelayWorker();
