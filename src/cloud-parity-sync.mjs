export class CloudParitySync {
  constructor({ baseUrl, token, workerId = 'mac', manifestSource, fetchImpl = fetch, timeoutMs = 30_000 }) {
    const url = new URL(String(baseUrl));
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('cloud parity requires an HTTPS origin without credentials');
    }
    if (!token || !/^[A-Za-z0-9_-]{1,64}$/.test(workerId)
      || typeof manifestSource !== 'function' || typeof fetchImpl !== 'function'
      || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30_000) {
      throw new Error('invalid cloud parity client configuration');
    }
    this.baseUrl = url.origin;
    this.token = token;
    this.workerId = workerId;
    this.manifestSource = manifestSource;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(path, options = {}) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...options,
      headers: { authorization: `Bearer ${this.token}`,
        ...(options.body ? { 'content-type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    let result;
    try { result = await response.json(); } catch { throw new Error('cloud_parity_invalid_response'); }
    if (!response.ok || !result?.ok) {
      throw new Error(String(result?.error || `cloud_parity_http_${response.status}`).slice(0, 120));
    }
    return result;
  }

  async reconcile() {
    const manifest = await this.manifestSource();
    const status = await this.status();
    if (!Number.isSafeInteger(status.workerSequence) || status.workerSequence < 0) {
      throw new Error('cloud_parity_invalid_sequence');
    }
    if (status.digest === manifest.digest) {
      return { changed: false, revision: status.revision, digest: manifest.digest,
        workerSequence: status.workerSequence };
    }
    const workerSequence = status.workerSequence + 1;
    const updated = await this.request('/parity/snapshot', { method: 'PUT',
      body: JSON.stringify({ workerId: this.workerId,
        sequence: workerSequence, manifest }) });
    if (updated.digest !== manifest.digest) throw new Error('cloud_parity_digest_mismatch');
    return { changed: true, revision: updated.revision, digest: manifest.digest,
      workerSequence };
  }

  async status() {
    return this.request(`/parity/status?workerId=${encodeURIComponent(this.workerId)}`);
  }
}
