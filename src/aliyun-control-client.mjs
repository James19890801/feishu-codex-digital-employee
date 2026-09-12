function fail(code) { return Object.assign(new Error(code), { code }); }

export class AliyunControlClient {
  constructor({ baseUrl, tokenSupplier, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
    const url = new URL(String(baseUrl || ''));
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash
      || url.username || url.password) throw new TypeError('coordinator must be an HTTPS origin');
    if (typeof tokenSupplier !== 'function') throw new TypeError('control token supplier required');
    this.baseUrl = url.origin;
    this.tokenSupplier = tokenSupplier;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async heartbeat(snapshot) {
    const token = await this.tokenSupplier();
    if (!token) throw fail('control_token_unavailable');
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/control/main-heartbeat`, {
        method: 'POST', body: JSON.stringify(snapshot),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
          accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch { throw fail('coordinator_unavailable'); }
    if (!response.ok) throw fail('coordinator_unavailable');
    let data;
    try { data = await response.json(); } catch { throw fail('invalid_coordinator_response'); }
    if (data?.ok !== true || data?.accepted !== true || !Number.isSafeInteger(data.generation)) {
      throw fail('coordinator_heartbeat_rejected');
    }
    return { accepted: true, generation: data.generation };
  }
}
