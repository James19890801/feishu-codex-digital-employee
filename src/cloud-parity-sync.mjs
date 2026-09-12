export class CloudParitySync {
  constructor({ baseUrl, token, workerId = 'mac', manifestSource, fetchImpl = fetch }) {
    const url = new URL(String(baseUrl));
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('cloud parity requires an HTTPS origin without credentials');
    }
    if (!token || !/^[A-Za-z0-9_-]{1,64}$/.test(workerId)
      || typeof manifestSource !== 'function' || typeof fetchImpl !== 'function') {
      throw new Error('invalid cloud parity client configuration');
    }
    this.baseUrl = url.origin;
    this.token = token;
    this.workerId = workerId;
    this.manifestSource = manifestSource;
    this.fetchImpl = fetchImpl;
  }

  async request(path, options = {}) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...options,
      headers: { authorization: `Bearer ${this.token}`,
        ...(options.body ? { 'content-type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(30_000),
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
    const status = await this.request(`/parity/status?workerId=${encodeURIComponent(this.workerId)}`);
    if (status.digest === manifest.digest) {
      return { changed: false, revision: status.revision, digest: manifest.digest };
    }
    const updated = await this.request('/parity/snapshot', { method: 'PUT',
      body: JSON.stringify({ workerId: this.workerId,
        sequence: Number(status.workerSequence || 0) + 1, manifest }) });
    if (updated.digest !== manifest.digest) throw new Error('cloud_parity_digest_mismatch');
    return { changed: true, revision: updated.revision, digest: manifest.digest };
  }
}
