function errorCode(error) {
  return String(error?.cause?.code || error?.code || '').toUpperCase();
}

function isLoopbackUrl(input) {
  try {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input?.url);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

export function createDnsFallbackFetch({ directFetch, fallbackFetch }) {
  if (typeof directFetch !== 'function' || typeof fallbackFetch !== 'function') {
    throw new TypeError('Direct and fallback fetch implementations are required');
  }
  return async function dnsFallbackFetch(input, init = {}) {
    try {
      return await directFetch(input, init);
    } catch (error) {
      if (![
        'ENOTFOUND', 'EAI_AGAIN',
        'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
      ].includes(errorCode(error)) || isLoopbackUrl(input)) {
        throw error;
      }
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input?.url);
      if (url.protocol !== 'https:') throw error;
      return fallbackFetch(input, init);
    }
  };
}
