import { createHash } from 'node:crypto';
import {
  CANARY_PATH,
  createCanaryChallenge,
} from './wechat-reliability-canary.mjs';

const LOCAL_TIMEOUT_MS = 3_000;
const PUBLIC_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 16 * 1024;

function errorCode(error, { provider = false } = {}) {
  const name = String(error?.name || '').toLowerCase();
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || error || '').toLowerCase();
  if (name.includes('timeout') || name === 'aborterror' || message.includes('timed out')) return 'timeout';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || message.includes('enotfound')) {
    return provider ? 'network_failure' : 'dns_failure';
  }
  if (provider) {
    if (/\b(401|403)\b|invalid token|authentication|unauthori[sz]ed/.test(message)) {
      return 'authentication_failed';
    }
    if (/\b429\b|rate limit/.test(message)) return 'rate_limited';
    if (/\b5\d\d\b/.test(message)) return 'provider_5xx';
    return 'provider_failure';
  }
  return 'network_failure';
}

function validateLoopbackBaseUrl(value, name) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error(`${name} must use HTTP on a loopback host`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} cannot contain credentials, query, or fragment`);
  }
  return url.origin;
}

function validatePublicBaseUrl(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('publicBaseUrl must use HTTPS without credentials, query, or fragment');
  }
  return url.origin;
}

async function fetchBounded(fetchImpl, url, {
  timeoutMs,
  maxResponseBytes = MAX_RESPONSE_BYTES,
}) {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json, text/plain;q=0.8' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response?.ok) {
      return { ok: false, errorCode: `http_${Number(response?.status) || 0}` };
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > maxResponseBytes) {
      return { ok: false, errorCode: 'response_too_large' };
    }
    return { ok: true, text };
  } catch (error) {
    return { ok: false, errorCode: errorCode(error) };
  }
}

async function probeCanary({
  baseUrl,
  canarySecret,
  fetchImpl,
  nowMs,
  nonce,
  timeoutMs,
}) {
  const challenge = createCanaryChallenge({ secret: canarySecret, nowMs, nonce });
  const url = new URL(CANARY_PATH, `${baseUrl}/`);
  for (const [name, value] of Object.entries(challenge)) url.searchParams.set(name, value);
  const fetched = await fetchBounded(fetchImpl, url, { timeoutMs });
  if (!fetched.ok) return fetched;
  let payload;
  try {
    payload = JSON.parse(fetched.text);
  } catch {
    return { ok: false, errorCode: 'invalid_json' };
  }
  const expectedDigest = createHash('sha256').update(challenge.nonce).digest('hex');
  if (payload?.ok !== true || payload?.nonceDigest !== expectedDigest) {
    return { ok: false, errorCode: 'nonce_mismatch' };
  }
  return { ok: true, errorCode: null };
}

export async function probePublicCanary({
  baseUrl,
  canarySecret,
  fetchImpl = globalThis.fetch,
  nowMs = Date.now(),
  nonce,
}) {
  const safeBaseUrl = validatePublicBaseUrl(baseUrl);
  return probeCanary({
    baseUrl: safeBaseUrl,
    canarySecret,
    fetchImpl,
    nowMs,
    nonce,
    timeoutMs: PUBLIC_TIMEOUT_MS,
  });
}

export async function probeLocalCanary({
  baseUrl,
  canarySecret,
  fetchImpl = globalThis.fetch,
  nowMs = Date.now(),
  nonce,
}) {
  const safeBaseUrl = validateLoopbackBaseUrl(baseUrl, 'localUrl');
  return probeCanary({
    baseUrl: safeBaseUrl,
    canarySecret,
    fetchImpl,
    nowMs,
    nonce,
    timeoutMs: LOCAL_TIMEOUT_MS,
  });
}

export async function probeTunnel({
  metricsUrl,
  fetchImpl = globalThis.fetch,
}) {
  const safeBaseUrl = validateLoopbackBaseUrl(metricsUrl, 'metricsUrl');
  const ready = await fetchBounded(fetchImpl, `${safeBaseUrl}/ready`, {
    timeoutMs: LOCAL_TIMEOUT_MS,
  });
  if (!ready.ok) return { ...ready, activeConnections: 0 };
  const metrics = await fetchBounded(fetchImpl, `${safeBaseUrl}/metrics`, {
    timeoutMs: LOCAL_TIMEOUT_MS,
    maxResponseBytes: 512 * 1024,
  });
  if (!metrics.ok) return { ...metrics, activeConnections: 0 };
  const values = [...metrics.text.matchAll(
    /^cloudflared_tunnel_ha_connections(?:\{[^}]*\})?\s+([0-9]+(?:\.[0-9]+)?)\s*$/gm,
  )].map(match => Number(match[1]));
  if (!values.length) {
    return { ok: false, errorCode: 'connections_metric_missing', activeConnections: 0 };
  }
  const activeConnections = Math.max(...values);
  if (activeConnections < 1) {
    return { ok: false, errorCode: 'zero_connections', activeConnections };
  }
  return { ok: true, errorCode: null, activeConnections };
}

export async function probeProvider({ checkOnline }) {
  try {
    const online = await checkOnline();
    return online === true
      ? { ok: true, errorCode: null }
      : { ok: false, errorCode: 'account_offline' };
  } catch (error) {
    return { ok: false, errorCode: errorCode(error, { provider: true }) };
  }
}

export async function probeProviderCallback({ alignCallback, nowMs = Date.now() }) {
  try {
    await alignCallback();
    return {
      ok: true,
      errorCode: null,
      lastRegisteredAt: new Date(Number(nowMs)).toISOString(),
    };
  } catch (error) {
    return {
      ok: false,
      errorCode: errorCode(error, { provider: true }),
      lastRegisteredAt: null,
    };
  }
}

async function timed(probe) {
  const startedAt = Date.now();
  const result = await probe();
  return { ...result, durationMs: Math.max(0, Date.now() - startedAt) };
}

export async function collectWechatReliabilitySample({
  localUrl,
  metricsUrl,
  publicBaseUrl,
  canarySecret,
  provider,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  nonceFactory,
}) {
  const safeLocalUrl = validateLoopbackBaseUrl(localUrl, 'localUrl');
  const safeMetricsUrl = validateLoopbackBaseUrl(metricsUrl, 'metricsUrl');
  const safePublicBaseUrl = validatePublicBaseUrl(publicBaseUrl);
  if (typeof provider?.checkOnline !== 'function' || typeof provider?.alignCallback !== 'function') {
    throw new Error('provider checkOnline and alignCallback functions are required');
  }
  const nowMs = Number(now());
  const localNonce = nonceFactory?.() || undefined;
  const publicNonce = nonceFactory?.() || undefined;
  const [local, tunnel, publicCallback, providerState] = await Promise.all([
    timed(() => probeLocalCanary({
      baseUrl: safeLocalUrl,
      canarySecret,
      fetchImpl,
      nowMs,
      nonce: localNonce,
    })),
    timed(() => probeTunnel({ metricsUrl: safeMetricsUrl, fetchImpl })),
    timed(() => probePublicCanary({
      baseUrl: safePublicBaseUrl,
      canarySecret,
      fetchImpl,
      nowMs,
      nonce: publicNonce,
    })),
    timed(() => probeProvider({ checkOnline: provider.checkOnline })),
  ]);
  const callbackRegistration = providerState.ok
    ? await timed(() => probeProviderCallback({
        alignCallback: provider.alignCallback,
        nowMs,
      }))
    : {
        ok: false,
        errorCode: 'provider_unavailable',
        lastRegisteredAt: null,
        durationMs: 0,
      };
  return {
    checkedAt: new Date(nowMs).toISOString(),
    layers: {
      local_service: local,
      tunnel,
      public_callback: publicCallback,
      provider: providerState,
      callback_registration: callbackRegistration,
    },
  };
}
