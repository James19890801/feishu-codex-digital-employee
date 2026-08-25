const TECHNICAL_FAILURE_CODES = new Set([
  'NETWORK_ERROR',
  'PROCESS_TIMEOUT',
  'AI_RUNTIME_EMPTY_RESPONSE',
  'HTTP_408',
  'HTTP_429',
  'REMOTE_STATUS_ERROR',
  'REMOTE_STATUS_FAILED',
  'REMOTE_STATUS_TIMEOUT',
]);

export function onlineRuntimeFailureCode(error) {
  const explicit = String(error?.code || '').trim().toUpperCase();
  if (explicit) return explicit;
  const message = String(error?.message || '');
  const matched = message.match(/AI-Lab Agent failed:\s*([A-Z0-9_]+)/i);
  return String(matched?.[1] || 'UNKNOWN').toUpperCase();
}

export function isOnlineRuntimeTechnicalFailure(error) {
  const code = onlineRuntimeFailureCode(error);
  if (TECHNICAL_FAILURE_CODES.has(code)) return true;
  const httpStatus = code.match(/^HTTP_(\d{3})$/);
  return Boolean(httpStatus && Number(httpStatus[1]) >= 500);
}

function runtimeId(client) {
  return String(client?.runtime?.id || 'unknown');
}

export class OnlineFirstRuntimeRouter {
  constructor({
    onlineClient,
    localClient,
    circuitOpenMs = 30_000,
    now = () => Date.now(),
  } = {}) {
    if (!onlineClient || typeof onlineClient.run !== 'function') {
      throw new TypeError('Online AI runtime client is required');
    }
    if (!localClient || typeof localClient.run !== 'function') {
      throw new TypeError('Local fallback AI runtime client is required');
    }
    this.onlineClient = onlineClient;
    this.localClient = localClient;
    this.runtime = onlineClient.runtime;
    this.circuitOpenMs = Math.max(1_000, Number(circuitOpenMs) || 30_000);
    this.now = now;
    this.circuitOpenUntil = 0;
    this.lastFailureCode = '';
  }

  route(result, { fallback, fallbackReason = '' }) {
    return {
      ...result,
      route: {
        strategy: 'online-first',
        primary: runtimeId(this.onlineClient),
        active: runtimeId(fallback ? this.localClient : this.onlineClient),
        fallback,
        fallbackReason,
      },
    };
  }

  async run(prompt, options = {}) {
    const hasImages = Array.isArray(options.images) && options.images.some(Boolean);
    if (hasImages && this.onlineClient.runtime?.supportsImages === false) {
      const result = await this.localClient.run(prompt, options);
      return this.route(result, {
        fallback: true,
        fallbackReason: 'UNSUPPORTED_IMAGES',
      });
    }
    if (this.now() < this.circuitOpenUntil) {
      const result = await this.localClient.run(prompt, options);
      return this.route(result, {
        fallback: true,
        fallbackReason: this.lastFailureCode || 'CIRCUIT_OPEN',
      });
    }

    try {
      const result = await this.onlineClient.run(prompt, options);
      this.circuitOpenUntil = 0;
      this.lastFailureCode = '';
      return this.route(result, { fallback: false });
    } catch (error) {
      if (!isOnlineRuntimeTechnicalFailure(error)) throw error;
      this.lastFailureCode = onlineRuntimeFailureCode(error);
      this.circuitOpenUntil = this.now() + this.circuitOpenMs;
      const result = await this.localClient.run(prompt, options);
      return this.route(result, {
        fallback: true,
        fallbackReason: this.lastFailureCode,
      });
    }
  }
}
