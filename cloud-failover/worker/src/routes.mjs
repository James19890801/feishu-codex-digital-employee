import { verifySignedRequest } from './auth.mjs';

const noStore = { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' };
const json = (status, value) => new Response(JSON.stringify(value), { status, headers: noStore });

export function createFailoverWorker({ maxBodyBytes = 64 * 1024 } = {}) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/internal/container/')) {
        if (request.headers.get('authorization') !== `Bearer ${env.AIPROS_CONTAINER_TOKEN}`) {
          return json(401, { ok: false, error: { code: 'unauthorized', message: 'Unauthorized' } });
        }
        try {
          const payload = await request.json();
          const stub = env.FAILOVER_COORDINATOR.get(
            env.FAILOVER_COORDINATOR.idFromName(env.AIPROS_NODE_ID),
          );
          let result;
          if (url.pathname === '/internal/container/ready') result = await stub.containerReady(payload.generation);
          else if (url.pathname === '/internal/container/claim') result = await stub.claim(payload);
          else if (url.pathname === '/internal/container/complete') result = await stub.complete(payload);
          else if (url.pathname === '/internal/container/qoder') result = await stub.executeQoder(payload);
          else return json(404, { ok: false, error: { code: 'not_found', message: 'Not found' } });
          return json(200, { ok: true, ...result });
        } catch (error) {
          return json(400, { ok: false, error: {
            code: String(error?.code || 'internal_request_failed').slice(0, 64),
            message: String(error?.message || error).slice(0, 200),
          } });
        }
      }
      if (!['/v1/heartbeat', '/v1/runtime/execute', '/v1/status'].includes(url.pathname)) {
        return json(404, { ok: false, error: { code: 'not_found', message: 'Not found' } });
      }
      const declaredLength = Number(request.headers.get('content-length') || 0);
      if (declaredLength > maxBodyBytes) {
        return json(413, { ok: false, error: { code: 'request_too_large', message: 'Request too large' } });
      }
      try {
        const id = env.FAILOVER_COORDINATOR.idFromName(env.AIPROS_NODE_ID);
        const stub = env.FAILOVER_COORDINATOR.get(id);
        const replayStore = {
          use: (node, nonce, expiresAt, now) => stub.useNonce(node, nonce, expiresAt, now),
        };
        const verified = await verifySignedRequest(request, env, replayStore);
        if (new TextEncoder().encode(verified.body).byteLength > maxBodyBytes) {
          return json(413, { ok: false, error: { code: 'request_too_large', message: 'Request too large' } });
        }
        const payload = verified.body ? JSON.parse(verified.body) : {};
        let result;
        if (url.pathname === '/v1/heartbeat' && request.method === 'POST') result = await stub.heartbeat(payload);
        else if (url.pathname === '/v1/runtime/execute' && request.method === 'POST') result = await stub.executeQoder(payload);
        else if (url.pathname === '/v1/status' && request.method === 'GET') result = await stub.status();
        else return json(405, { ok: false, error: { code: 'method_not_allowed', message: 'Method not allowed' } });
        return json(200, { ok: true, ...result });
      } catch (error) {
        const code = String(error?.code || 'request_failed').slice(0, 64);
        const status = ['invalid_signature', 'request_expired', 'nonce_replayed', 'unknown_node'].includes(code)
          ? 401 : code === 'request_too_large' ? 413 : 400;
        return json(status, { ok: false, error: { code, message: String(error?.message || error).slice(0, 200) } });
      }
    },
  };
}
