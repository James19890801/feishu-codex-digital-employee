import assert from 'node:assert/strict';

import { createLicensingFetch, LicensingClient } from './client.mjs';

const proxyDispatcher = { name: 'test-proxy-dispatcher' };
const proxyRequests = [];
const proxyFetch = createLicensingFetch({
  proxyUrl: 'http://127.0.0.1:7890',
  proxyAgentFactory: url => {
    assert.equal(url, 'http://127.0.0.1:7890/');
    return proxyDispatcher;
  },
  fetchImpl: async (url, options) => {
    proxyRequests.push({ url: String(url), options });
    return new Response('{}');
  },
});
await proxyFetch('https://licensing.example.test/health', { method: 'GET' });
assert.equal(proxyRequests[0].options.dispatcher, proxyDispatcher);
assert.throws(
  () => createLicensingFetch({ proxyUrl: 'socks5://127.0.0.1:1080' }),
  error => error.code === 'invalid_licensing_proxy_url',
);
assert.throws(
  () => createLicensingFetch({ proxyUrl: 'http://user:secret@127.0.0.1:7890' }),
  error => error.code === 'invalid_licensing_proxy_url',
);

const requests = [];
const client = new LicensingClient({
  serviceUrl: 'https://licensing.example.test',
  fetchImpl: async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({
      ok: true,
      entitlement: 'signed.entitlement',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  },
});

const activated = await client.activate({
  code: '1234567890',
  deviceKeyHash: `sha256:${'a'.repeat(64)}`,
  installId: 'install_12345678',
});
assert.equal(activated.entitlement, 'signed.entitlement');
assert.equal(requests[0].url, 'https://licensing.example.test/v1/activate');
assert.equal(JSON.parse(requests[0].options.body).code, '1234567890');

assert.throws(
  () => new LicensingClient({ serviceUrl: 'http://public.example.test' }),
  error => error.code === 'insecure_licensing_url',
);
assert.doesNotThrow(() => new LicensingClient({
  serviceUrl: 'http://127.0.0.1:8787',
  allowInsecureLoopback: true,
}));
await assert.rejects(
  () => client.activate({
    code: 'abc',
    deviceKeyHash: `sha256:${'a'.repeat(64)}`,
    installId: 'install_12345678',
  }),
  error => error.code === 'invalid_activation_request',
);

const oversized = new LicensingClient({
  serviceUrl: 'https://licensing.example.test',
  maxResponseBytes: 128,
  fetchImpl: async () => new Response(JSON.stringify({ data: 'x'.repeat(500) }), {
    headers: { 'content-type': 'application/json' },
  }),
});
await assert.rejects(
  () => oversized.activate({
    code: '1234567890',
    deviceKeyHash: `sha256:${'a'.repeat(64)}`,
    installId: 'install_12345678',
  }),
  error => error.code === 'licensing_response_too_large',
);

const secret = 'do-not-leak-this-invitation';
const failing = new LicensingClient({
  serviceUrl: 'https://licensing.example.test',
  fetchImpl: async () => new Response(JSON.stringify({
    ok: false,
    error: { code: 'invalid_invitation', message: secret },
  }), { status: 400, headers: { 'content-type': 'application/json' } }),
});
await assert.rejects(
  () => failing.activate({
    code: '1234567890',
    deviceKeyHash: `sha256:${'a'.repeat(64)}`,
    installId: 'install_12345678',
  }),
  error => error.code === 'invalid_invitation' && !error.message.includes(secret),
);

const timedOut = new LicensingClient({
  serviceUrl: 'https://licensing.example.test',
  timeoutMs: 10,
  fetchImpl: async (_url, { signal }) => new Promise((resolve, reject) => {
    const keepAlive = setTimeout(resolve, 1_000);
    signal.addEventListener('abort', () => {
      clearTimeout(keepAlive);
      reject(signal.reason);
    });
  }),
});
await assert.rejects(
  () => timedOut.activate({
    code: '1234567890',
    deviceKeyHash: `sha256:${'a'.repeat(64)}`,
    installId: 'install_12345678',
  }),
  error => error.code === 'licensing_unavailable',
);

console.log('LICENSING_CLIENT_TEST_OK');
