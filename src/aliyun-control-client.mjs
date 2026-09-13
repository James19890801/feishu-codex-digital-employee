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

  async status() {
    const token = await this.tokenSupplier();
    if (!token) throw fail('control_token_unavailable');
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/control/status`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch { throw fail('coordinator_unavailable'); }
    if (!response.ok) throw fail('coordinator_unavailable');
    let data;
    try { data = await response.json(); } catch { throw fail('invalid_coordinator_response'); }
    if (data?.ok !== true || !['LOCAL_PRIMARY', 'CLOUD_ACTIVE', 'DRAINING', 'DISABLED'].includes(data.state)
      || !Number.isSafeInteger(data.generation) || data.generation < 0) {
      throw fail('invalid_coordinator_response');
    }
    return { state: data.state, owner: data.owner || null, generation: data.generation };
  }

  async localGeneration() {
    let status = await this.status();
    if (status.state === 'DISABLED') {
      const token = await this.tokenSupplier();
      if (!token) throw fail('control_token_unavailable');
      let response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/control/start`, {
          method: 'POST', body: '{}',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
            accept: 'application/json' },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch { throw fail('coordinator_unavailable'); }
      if (!response.ok) throw fail('coordinator_unavailable');
      try {
        const result = await response.json();
        if (result?.ok !== true || !Number.isSafeInteger(result.generation)) {
          throw fail('invalid_coordinator_response');
        }
        status = { state: result.state, owner: result.owner, generation: result.generation };
      } catch { throw fail('invalid_coordinator_response'); }
    }
    if (status.state !== 'LOCAL_PRIMARY' || status.owner !== 'mac' || status.generation < 1) {
      throw fail('local_not_leader');
    }
    return status.generation;
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

  async recoveryHeartbeat({ healthy } = {}) {
    if (typeof healthy !== 'boolean') throw new TypeError('recovery_health_required');
    return this.#controlAction('/control/recovery', { healthy });
  }

  async finishCloudDrain() {
    return this.#controlAction('/control/drain-complete', {});
  }

  async #controlAction(path, body) {
    const token = await this.tokenSupplier();
    if (!token) throw fail('control_token_unavailable');
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST', body: JSON.stringify(body),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json',
          accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch { throw fail('coordinator_unavailable'); }
    if (!response.ok) throw fail('coordinator_unavailable');
    let data;
    try { data = await response.json(); } catch { throw fail('invalid_coordinator_response'); }
    if (data?.ok !== true || !['LOCAL_PRIMARY', 'CLOUD_ACTIVE', 'DRAINING'].includes(data?.state)
      || !Number.isSafeInteger(data?.generation)) throw fail('invalid_coordinator_response');
    return data;
  }
}
