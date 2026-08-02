import assert from 'node:assert/strict';

import { LicensingClient } from './client.mjs';

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
