const DEFAULT_BASE_URL = 'https://api.qoder.com/api/v1/cloud';
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

function apiError(status, message) {
  const error = new Error(`Qoder Cloud API failed (${status}): ${String(message || 'request failed').slice(0, 200)}`);
  error.code = 'qoder_api_error';
  error.status = status;
  return error;
}

function eventText(data) {
  if (typeof data === 'string') return data;
  if (typeof data?.text === 'string') return data.text;
  if (typeof data?.content === 'string') return data.content;
  if (typeof data?.message?.content === 'string') return data.message.content;
  const content = data?.content || data?.message?.content;
  if (Array.isArray(content)) {
    return content.map(item => typeof item === 'string' ? item : item?.text || '').join('');
  }
  return '';
}

export function parseQoderSse(text, maxBytes = 2 * 1024 * 1024) {
  if (new TextEncoder().encode(String(text || '')).byteLength > maxBytes) {
    throw Object.assign(new Error('Qoder SSE response is too large'), { code: 'qoder_response_too_large' });
  }
  const messages = [];
  let terminal = false;
  for (const block of String(text || '').split(/\r?\n\r?\n/)) {
    let type = '';
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) type = line.slice(6).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!type || !dataLines.length) continue;
    let data;
    try { data = JSON.parse(dataLines.join('\n')); } catch { continue; }
    if (type === 'agent.message') {
      const textValue = eventText(data);
      if (textValue) messages.push(textValue);
    }
    if (type === 'session.status_idle') terminal = true;
  }
  if (!terminal) throw Object.assign(new Error('Qoder SSE ended before session.status_idle'), {
    code: 'qoder_stream_incomplete',
  });
  const result = messages.join('').trim();
  if (!result) throw Object.assign(new Error('Qoder returned an empty response'), {
    code: 'qoder_empty_response',
  });
  return result;
}

export async function readQoderSse(response, {
  maxBytes = 2 * 1024 * 1024,
  timeoutMs = 180_000,
} = {}) {
  const reader = response.body?.getReader();
  if (!reader) return parseQoderSse(await response.text(), maxBytes);
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      let timer;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw Object.assign(new Error('Qoder SSE timed out'), {
        code: 'qoder_stream_timeout',
      });
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('Qoder SSE timed out'), {
          code: 'qoder_stream_timeout',
        })), remainingMs);
      });
      const { done, value } = await Promise.race([reader.read(), timeout]);
      clearTimeout(timer);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        throw Object.assign(new Error('Qoder SSE response is too large'), {
          code: 'qoder_response_too_large',
        });
      }
      text += decoder.decode(value, { stream: true });
      try {
        const result = parseQoderSse(text, maxBytes);
        await reader.cancel();
        return result;
      } catch (error) {
        if (error?.code !== 'qoder_stream_incomplete') throw error;
      }
    }
    text += decoder.decode();
    return parseQoderSse(text, maxBytes);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export class QoderCloudClient {
  constructor({
    pat,
    agentId,
    agentVersion = 0,
    environmentId,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl,
    delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
    now = () => Date.now(),
    streamTimeoutMs = 180_000,
    cleanupTimeoutMs = 5_000,
  } = {}) {
    this.pat = String(pat || '');
    this.agentId = String(agentId || '');
    this.agentVersion = Number(agentVersion);
    this.environmentId = String(environmentId || '');
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
    this.fetchImpl = fetchImpl || ((...args) => fetch(...args));
    this.delay = delay;
    this.now = now;
    this.streamTimeoutMs = Math.max(1, Number(streamTimeoutMs) || 180_000);
    this.cleanupTimeoutMs = Math.max(1, Number(cleanupTimeoutMs) || 5_000);
    if (!this.pat || !this.agentId || !this.environmentId) {
      throw new TypeError('Qoder PAT, agent ID, and environment ID are required');
    }
    if (!Number.isInteger(this.agentVersion) || this.agentVersion < 0) {
      throw new TypeError('Qoder agent version must be a non-negative integer');
    }
  }

  async waitForTerminal(sessionId) {
    const deadline = Date.now() + this.cleanupTimeoutMs;
    while (Date.now() < deadline) {
      const response = await this.request(`/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'GET',
      });
      const session = await response.json();
      const status = String(session.status || session.state || '').toLowerCase();
      if (status.endsWith('idle') || ['canceled', 'cancelled', 'failed', 'error'].includes(status)) {
        return true;
      }
      await this.delay(Math.min(250, Math.max(1, deadline - Date.now())));
    }
    return false;
  }

  async request(path, { method = 'POST', body = null, accept = 'application/json' } = {}) {
    const payload = body === null ? undefined : JSON.stringify(body);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          body: payload,
          headers: {
            authorization: `Bearer ${this.pat}`,
            accept,
            ...(payload ? { 'content-type': 'application/json' } : {}),
          },
        });
      } catch (error) {
        if (attempt === 3) {
          console.error('qoder_fetch_failed', {
            errorName: String(error?.name || 'Error').slice(0, 64),
            errorMessage: String(error?.message || error).slice(0, 200),
            path: String(path).split('?')[0].slice(0, 160),
          });
          throw Object.assign(new Error('Qoder Cloud API is unreachable'), {
            code: 'qoder_unreachable', cause: error,
          });
        }
        await this.delay(2 ** attempt * 1_000);
        continue;
      }
      if (response.ok) return response;
      const message = await response.text().catch(() => '');
      if (!RETRYABLE.has(response.status) || attempt === 3) throw apiError(response.status, message);
      await this.delay(2 ** attempt * 1_000);
    }
    throw apiError(503, 'retry limit reached');
  }

  async execute({ prompt, digest, metadata = {} }) {
    const startedAt = this.now();
    let sessionId = '';
    try {
      const sessionResponse = await this.request('/sessions', {
        body: {
          agent: { id: this.agentId, type: 'agent', version: this.agentVersion },
          environment_id: this.environmentId,
          metadata: Object.fromEntries(Object.entries({ digest, ...metadata })
            .map(([key, value]) => [String(key), String(value)])),
        },
      });
      const session = await sessionResponse.json();
      sessionId = String(session.id || session.session_id || '');
      if (!sessionId) throw apiError(502, 'session ID missing');
      await this.request(`/sessions/${encodeURIComponent(sessionId)}/events`, {
        body: {
          events: [{
            type: 'user.message',
            content: [{ type: 'text', text: String(prompt || '') }],
          }],
        },
      });
      const eventResponse = await this.request(`/sessions/${encodeURIComponent(sessionId)}/events/stream`, {
        method: 'GET',
        accept: 'text/event-stream',
      });
      const text = await readQoderSse(eventResponse, { timeoutMs: this.streamTimeoutMs });
      return { text, sessionId, latencyMs: Math.max(0, this.now() - startedAt) };
    } catch (error) {
      if (sessionId) {
        const canceled = await this.request(`/sessions/${encodeURIComponent(sessionId)}/cancel`, { body: {} })
          .then(() => true)
          .catch(cancelError => {
            console.error('qoder_session_cancel_failed', {
              sessionId, code: String(cancelError?.code || cancelError?.status || 'unknown').slice(0, 64),
            });
            return false;
          });
        if (canceled) await this.waitForTerminal(sessionId).catch(waitError => {
          console.error('qoder_session_cancel_wait_failed', {
            sessionId, code: String(waitError?.code || waitError?.status || 'unknown').slice(0, 64),
          });
        });
      }
      throw error;
    } finally {
      if (sessionId) {
        await this.request(`/sessions/${encodeURIComponent(sessionId)}/archive`, { body: {} })
          .catch(archiveError => {
            console.error('qoder_session_archive_failed', {
              sessionId, code: String(archiveError?.code || archiveError?.status || 'unknown').slice(0, 64),
            });
          });
      }
    }
  }
}
