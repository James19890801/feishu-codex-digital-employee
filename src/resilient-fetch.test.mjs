import assert from 'node:assert/strict';
import test from 'node:test';

import { createDnsFallbackFetch } from './resilient-fetch.mjs';

test('uses direct fetch when the system resolver works', async () => {
  const calls = [];
  const directResponse = { ok: true, status: 200 };
  const fetchImpl = createDnsFallbackFetch({
    directFetch: async () => {
      calls.push('direct');
      return directResponse;
    },
    fallbackFetch: async () => {
      calls.push('fallback');
      return { ok: true, status: 200 };
    },
  });

  assert.equal(await fetchImpl('https://example.com/health'), directResponse);
  assert.deepEqual(calls, ['direct']);
});

test('retries HTTPS through the fallback only for DNS resolution failure', async () => {
  const calls = [];
  const dnsError = new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
  const fallbackResponse = { ok: true, status: 200 };
  const fetchImpl = createDnsFallbackFetch({
    directFetch: async () => {
      calls.push('direct');
      throw dnsError;
    },
    fallbackFetch: async (input, init) => {
      calls.push({ input: String(input), method: init.method });
      return fallbackResponse;
    },
  });

  assert.equal(await fetchImpl('https://random.trycloudflare.com/canary', { method: 'GET' }), fallbackResponse);
  assert.deepEqual(calls, [
    'direct',
    { input: 'https://random.trycloudflare.com/canary', method: 'GET' },
  ]);
});

test('retries transient network-switch failures through the fallback proxy', async () => {
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH']) {
    const transientError = new TypeError('fetch failed', { cause: { code } });
    const fallbackResponse = { ok: true, status: 200, code };
    const fetchImpl = createDnsFallbackFetch({
      directFetch: async () => { throw transientError; },
      fallbackFetch: async () => fallbackResponse,
    });
    assert.equal(await fetchImpl('https://example.com/health'), fallbackResponse);
  }
});

test('does not proxy connection refusal or loopback traffic', async () => {
  let fallbackCalls = 0;
  const connectionError = new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
  const dnsError = new TypeError('fetch failed', { cause: { code: 'EAI_AGAIN' } });
  const fallbackFetch = async () => {
    fallbackCalls += 1;
    return { ok: true, status: 200 };
  };

  await assert.rejects(createDnsFallbackFetch({
    directFetch: async () => { throw connectionError; },
    fallbackFetch,
  })('https://example.com/health'), error => error === connectionError);
  await assert.rejects(createDnsFallbackFetch({
    directFetch: async () => { throw dnsError; },
    fallbackFetch,
  })('http://127.0.0.1:17656/health'), error => error === dnsError);
  assert.equal(fallbackCalls, 0);
});
