import { createHash, createHmac, randomUUID } from 'node:crypto';

const JSON_TYPE = 'application/json';

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function secureBaseUrl(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:') throw new TypeError('Cloud failover base URL must use HTTPS');
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new TypeError('Cloud failover base URL must be an HTTPS origin without credentials');
  }
  return url.origin;
}

export function signFailoverRequest({ method, path, body = '', timestamp, nonce, secret }) {
  const contentSha256 = createHash('sha256').update(String(body)).digest('hex');
  const canonical = [
    String(method || '').toUpperCase(),
    String(path || ''),
    String(timestamp),
    String(nonce || ''),
    contentSha256,
  ].join('\n');
  return {
    contentSha256,
    signature: createHmac('sha256', String(secret || '')).update(canonical).digest('hex'),
  };
}

export class CloudFailoverClient {
  constructor({
    baseUrl,
    nodeId,
    secret,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    nonce = () => randomUUID(),
    timeoutMs = 90_000,
  } = {}) {
    this.baseUrl = secureBaseUrl(baseUrl);
    this.nodeId = String(nodeId || '').trim();
    this.secret = String(secret || '');
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.nonce = nonce;
    this.timeoutMs = Math.max(1_000, Math.min(300_000, Number(timeoutMs) || 90_000));
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(this.nodeId)) {
      throw new TypeError('Cloud failover node ID is invalid');
    }
    if (this.secret.length < 16) throw new TypeError('Cloud failover HMAC secret is required');
    if (typeof this.fetchImpl !== 'function') throw new TypeError('Cloud failover fetch is required');
  }

  async request(path, { method = 'GET', payload = null } = {}) {
    const body = payload === null ? '' : JSON.stringify(payload);
    const timestamp = this.now();
    const nonce = this.nonce();
    const signed = signFailoverRequest({
      method, path, body, timestamp, nonce, secret: this.secret,
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        body: body || undefined,
        signal: controller.signal,
        headers: {
          accept: JSON_TYPE,
          ...(body ? { 'content-type': JSON_TYPE } : {}),
          'cache-control': 'no-store',
          'x-aipros-node': this.nodeId,
          'x-aipros-timestamp': String(timestamp),
          'x-aipros-nonce': nonce,
          'x-aipros-content-sha256': signed.contentSha256,
          'x-aipros-signature': signed.signature,
        },
      });
    } catch (error) {
      throw fail('cloud_failover_unreachable', 'Cloud failover gateway is unreachable', {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().startsWith(JSON_TYPE)) {
      throw fail('cloud_failover_invalid_response', 'Cloud failover returned a non-JSON response');
    }
    let result;
    try {
      result = await response.json();
    } catch (error) {
      throw fail('cloud_failover_invalid_response', 'Cloud failover returned invalid JSON', {
        cause: error,
      });
    }
    if (!response.ok || result?.ok !== true) {
      throw fail(
        String(result?.error?.code || 'cloud_failover_request_failed'),
        String(result?.error?.message || `Cloud failover request failed with HTTP ${response.status}`),
        { status: response.status },
      );
    }
    return result;
  }

  async execute(input) {
    const payload = { ...input };
    const handoffKey = String(payload.handoffKey || '');
    delete payload.handoffKey;
    if (handoffKey) {
      payload.handoffId = createHash('sha256')
        .update(`${this.nodeId}\n${handoffKey}`)
        .digest('hex');
    }
    const response = await this.request('/v1/runtime/execute', {
      method: 'POST',
      payload,
    });
    if (typeof response?.result?.text !== 'string' || !response.result.text.trim()
      || typeof response.result.sessionId !== 'string'
      || !Number.isFinite(Number(response.result.latencyMs))) {
      throw fail('cloud_failover_invalid_response', 'Cloud failover result is incomplete');
    }
    return {
      text: response.result.text.trim(),
      sessionId: response.result.sessionId,
      latencyMs: Number(response.result.latencyMs),
      state: String(response.state || ''),
      generation: Number(response.generation || 0),
      handoff: response.handoff && typeof response.handoff === 'object'
        ? {
            status: String(response.handoff.status || ''),
            replayed: response.handoff.replayed === true,
          }
        : null,
    };
  }

  async heartbeat(input) {
    const response = await this.request('/v1/heartbeat', { method: 'POST', payload: input });
    return {
      state: String(response.state || ''),
      generation: Number(response.generation || 0),
    };
  }

  async status() {
    return this.request('/v1/status');
  }
}
