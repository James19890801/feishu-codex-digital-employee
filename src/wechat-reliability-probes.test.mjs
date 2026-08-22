import assert from 'node:assert/strict';
import {
  collectWechatReliabilitySample,
  probeProvider,
  probeProviderCallback,
  probePublicCanary,
  probeTunnel,
} from './wechat-reliability-probes.mjs';
import {
  createCanaryResponse,
  verifyCanaryChallenge,
} from './wechat-reliability-canary.mjs';

const canarySecret = 'probe_secret_12345678901234567890';
const nowMs = Date.parse('2026-08-22T12:00:00.000Z');

function canaryResponse(url) {
  const parsed = new URL(url);
  const challenge = {
    timestamp: parsed.searchParams.get('timestamp'),
    nonce: parsed.searchParams.get('nonce'),
    signature: parsed.searchParams.get('signature'),
  };
  assert.equal(verifyCanaryChallenge(challenge, { secret: canarySecret, nowMs }).ok, true);
  return new Response(JSON.stringify(createCanaryResponse(challenge, { nowMs })), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

{
  const calls = [];
  let alignmentCalls = 0;
  const result = await collectWechatReliabilitySample({
    localUrl: 'http://127.0.0.1:17656',
    metricsUrl: 'http://127.0.0.1:17657',
    publicBaseUrl: 'https://wechat.example.com',
    canarySecret,
    provider: {
      checkOnline: async () => true,
      alignCallback: async () => { alignmentCalls += 1; },
    },
    fetchImpl: async url => {
      calls.push(String(url));
      if (String(url).endsWith('/ready')) return new Response('ready', { status: 200 });
      if (String(url).endsWith('/metrics')) {
        return new Response('# HELP connections\ncloudflared_tunnel_ha_connections 4\n', { status: 200 });
      }
      return canaryResponse(url);
    },
    now: () => nowMs,
    nonceFactory: () => 'deterministic-probe-nonce',
  });
  assert.deepEqual(Object.fromEntries(Object.entries(result.layers).map(([name, layer]) => [name, layer.ok])), {
    local_service: true,
    tunnel: true,
    public_callback: true,
    provider: true,
    callback_registration: true,
  });
  assert.equal(result.layers.tunnel.activeConnections, 4);
  assert.equal(result.layers.callback_registration.lastRegisteredAt, '2026-08-22T12:00:00.000Z');
  assert.equal(alignmentCalls, 1);
  assert.equal(calls.some(url => url.startsWith('https://wechat.example.com/')), true);
  assert.equal(calls.some(url => url.includes(canarySecret)), false);
}

{
  const tunnel = await probeTunnel({
    metricsUrl: 'http://127.0.0.1:17657',
    fetchImpl: async url => String(url).endsWith('/ready')
      ? new Response('ready', { status: 200 })
      : new Response('cloudflared_tunnel_ha_connections 0\n', { status: 200 }),
  });
  assert.equal(tunnel.ok, false);
  assert.equal(tunnel.errorCode, 'zero_connections');
  assert.equal(tunnel.activeConnections, 0);
}

{
  const publicProbe = await probePublicCanary({
    baseUrl: 'https://wechat.example.com',
    canarySecret,
    fetchImpl: async () => new Response(JSON.stringify({
      ok: true,
      nonceDigest: '0'.repeat(64),
      at: '2026-08-22T12:00:00.000Z',
    }), { status: 200 }),
    nowMs,
    nonce: 'mismatch-nonce',
  });
  assert.equal(publicProbe.ok, false);
  assert.equal(publicProbe.errorCode, 'nonce_mismatch');
}

{
  const cases = [
    [async () => new Response('no', { status: 503 }), 'http_503'],
    [async () => new Response('{bad-json', { status: 200 }), 'invalid_json'],
    [async () => { const error = new Error('getaddrinfo ENOTFOUND private.example'); error.code = 'ENOTFOUND'; throw error; }, 'dns_failure'],
    [async () => { const error = new Error('timed out'); error.name = 'TimeoutError'; throw error; }, 'timeout'],
  ];
  for (const [fetchImpl, expected] of cases) {
    const result = await probePublicCanary({
      baseUrl: 'https://wechat.example.com',
      canarySecret,
      fetchImpl,
      nowMs,
      nonce: 'bounded-error-probe',
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, expected);
    assert.equal(JSON.stringify(result).includes('private.example'), false);
  }
}

{
  assert.deepEqual(await probeProvider({ checkOnline: async () => true }), {
    ok: true,
    errorCode: null,
  });
  assert.deepEqual(await probeProvider({ checkOnline: async () => false }), {
    ok: false,
    errorCode: 'account_offline',
  });
  assert.equal((await probeProvider({
    checkOnline: async () => { throw new Error('HTTP 401 invalid token'); },
  })).errorCode, 'authentication_failed');
  const networkError = new Error('getaddrinfo ENOTFOUND api.geweapi.com');
  networkError.code = 'ENOTFOUND';
  assert.equal((await probeProvider({
    checkOnline: async () => { throw networkError; },
  })).errorCode, 'network_failure');
}

{
  const successful = await probeProviderCallback({
    alignCallback: async () => ({ ret: 200 }),
    nowMs,
  });
  assert.equal(successful.ok, true);
  assert.equal(successful.lastRegisteredAt, '2026-08-22T12:00:00.000Z');

  const failed = await probeProviderCallback({
    alignCallback: async () => { throw new Error('HTTP 503 with secret body'); },
    nowMs,
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.lastRegisteredAt, null);
  assert.equal(failed.errorCode, 'provider_5xx');
  assert.equal(JSON.stringify(failed).includes('secret body'), false);
}

await assert.rejects(
  collectWechatReliabilitySample({
    localUrl: 'http://remote.example.com:17656',
    metricsUrl: 'http://127.0.0.1:17657',
    publicBaseUrl: 'http://wechat.example.com',
    canarySecret,
    provider: { checkOnline: async () => true, alignCallback: async () => {} },
  }),
  /localUrl|loopback/i,
);

console.log('WECHAT_RELIABILITY_PROBES_TEST_OK');
