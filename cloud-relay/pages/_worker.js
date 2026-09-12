const UPSTREAM_ORIGIN = 'https://aipro-wechat-relay.494161546.workers.dev';

export function createPagesProxy({
  upstreamOrigin = UPSTREAM_ORIGIN,
  fetchImpl = globalThis.fetch,
} = {}) {
  const origin = new URL(upstreamOrigin).origin;
  return {
    async fetch(request) {
      const incoming = new URL(request.url);
      const target = new URL(`${incoming.pathname}${incoming.search}`, `${origin}/`);
      const forwarded = new Request(target, request);
      return fetchImpl(forwarded);
    },
  };
}

export default createPagesProxy();
