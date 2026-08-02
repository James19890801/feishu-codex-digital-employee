const DEVICE_KEY_HASH = /^sha256:[a-f0-9]{64}$/;
const INVITATION_CODE = /^\d{10}$/;
const INSTALL_ID = /^[A-Za-z0-9_-]{8,128}$/;

class LicensingClientError extends Error {
  constructor(message, code, status = 0) {
    super(message);
    this.name = 'LicensingClientError';
    this.code = code;
    this.status = status;
  }
}

function checkedServiceUrl(value, allowInsecureLoopback) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new LicensingClientError('Licensing service URL is invalid.', 'invalid_licensing_url');
  }
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(allowInsecureLoopback && loopback && url.protocol === 'http:')) {
    throw new LicensingClientError('Licensing service requires HTTPS.', 'insecure_licensing_url');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new LicensingClientError('Licensing service URL is invalid.', 'invalid_licensing_url');
  }
  url.pathname = url.pathname.replace(/\/$/, '');
  return url;
}

function publicMessage(code) {
  if (code === 'invalid_invitation') return 'Invitation code cannot be used.';
  if (code === 'rate_limited') return 'Try again later.';
  if (code === 'issuer_authorization_failed') return 'Issuer authorization failed.';
  if (code === 'recovery_failed') return 'Founder recovery failed.';
  return 'Licensing request failed.';
}

export class LicensingClient {
  constructor({
    serviceUrl,
    fetchImpl = fetch,
    timeoutMs = 15_000,
    maxResponseBytes = 64 * 1024,
    allowInsecureLoopback = false,
  } = {}) {
    this.serviceUrl = checkedServiceUrl(serviceUrl, allowInsecureLoopback);
    this.fetchImpl = fetchImpl;
    this.timeoutMs = Math.min(Math.max(Number(timeoutMs) || 15_000, 1), 60_000);
    this.maxResponseBytes = Math.min(
      Math.max(Number(maxResponseBytes) || 64 * 1024, 128),
      1024 * 1024,
    );
  }

  async request(path, body) {
    let response;
    try {
      response = await this.fetchImpl(new URL(path, this.serviceUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new LicensingClientError('Licensing service is unavailable.', 'licensing_unavailable');
    }
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > this.maxResponseBytes) {
      throw new LicensingClientError('Licensing response is too large.', 'licensing_response_too_large');
    }
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > this.maxResponseBytes) {
      throw new LicensingClientError('Licensing response is too large.', 'licensing_response_too_large');
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new LicensingClientError('Licensing response is invalid.', 'invalid_licensing_response');
    }
    if (!response.ok || payload?.ok !== true) {
      const code = typeof payload?.error?.code === 'string'
        ? payload.error.code
        : 'licensing_request_failed';
      throw new LicensingClientError(publicMessage(code), code, response.status);
    }
    return payload;
  }

  async activate({ code, deviceKeyHash, installId }) {
    if (!INVITATION_CODE.test(code || '')
      || !DEVICE_KEY_HASH.test(deviceKeyHash || '')
      || !INSTALL_ID.test(installId || '')) {
      throw new LicensingClientError('Activation request is invalid.', 'invalid_activation_request');
    }
    return this.request('/v1/activate', { code, deviceKeyHash, installId });
  }

  async issuerChallenge({ issuerId }) {
    if (!/^[a-z0-9][a-z0-9-]{2,79}$/.test(issuerId || '')) {
      throw new LicensingClientError('Issuer request is invalid.', 'invalid_issuer_request');
    }
    return this.request('/v1/issuer/challenge', { issuerId });
  }

  async generateInvites({ issuerId, proof, request }) {
    return this.request('/v1/issuer/invites', { issuerId, proof, request });
  }

  async recoverFounder(body) {
    return this.request('/v1/founder/recover', body);
  }
}
