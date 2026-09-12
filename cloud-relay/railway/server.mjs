import { createServer } from 'node:http';
import process from 'node:process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

function originFor(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('UPSTREAM_ORIGIN must be an HTTPS origin');
  }
  return url.origin;
}

function writeJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

export function createRelayProxyServer({ upstreamOrigin, fetchImpl = globalThis.fetch }) {
  const origin = originFor(upstreamOrigin);
  return createServer(async (request, response) => {
    if (request.url === '/_proxy/healthz' && request.method === 'GET') {
      writeJson(response, 200, { ok: true, service: 'aipro-wechat-ingress' });
      return;
    }
    try {
      const target = new URL(request.url || '/', `${origin}/`);
      const method = String(request.method || 'GET').toUpperCase();
      const hasBody = !['GET', 'HEAD'].includes(method);
      const upstream = await fetchImpl(new Request(target, {
        method,
        headers: request.headers,
        body: hasBody ? Readable.toWeb(request) : undefined,
        duplex: hasBody ? 'half' : undefined,
        signal: AbortSignal.timeout(125_000),
      }));
      const headers = Object.fromEntries(upstream.headers);
      delete headers['content-encoding'];
      delete headers['content-length'];
      delete headers['transfer-encoding'];
      response.writeHead(upstream.status, headers);
      if (!upstream.body || method === 'HEAD') response.end();
      else Readable.fromWeb(upstream.body).pipe(response);
    } catch {
      if (!response.headersSent) writeJson(response, 502, { ok: false, error: 'upstream_unavailable' });
      else response.destroy();
    }
  });
}

function main() {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT is invalid');
  const server = createRelayProxyServer({
    upstreamOrigin: process.env.UPSTREAM_ORIGIN || 'https://aipro-wechat-relay.494161546.workers.dev',
  });
  server.requestTimeout = 130_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.listen(port, '0.0.0.0');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
