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

export class QoderCloudClient {
  constructor({
    pat,
    agentId,
    agentVersion = '1',
    environmentId,
    baseUrl = DEFAULT_BASE_URL,
    fetchImpl = globalThis.fetch,
    delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
    now = () => Date.now(),
  } = {}) {
    this.pat = String(pat || '');
    this.agentId = String(agentId || '');
    this.agentVersion = String(agentVersion || '1');
    this.environmentId = String(environmentId || '');
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.delay = delay;
    this.now = now;
    if (!this.pat || !this.agentId || !this.environmentId) {
      throw new TypeError('Qoder PAT, agent ID, and environment ID are required');
    }
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
        if (attempt === 3) throw Object.assign(new Error('Qoder Cloud API is unreachable'), {
          code: 'qoder_unreachable', cause: error,
        });
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
          agent: { id: this.agentId, version: this.agentVersion },
          environment_id: this.environmentId,
          metadata: Object.fromEntries(Object.entries({ digest, ...metadata })
            .map(([key, value]) => [String(key), String(value)])),
        },
      });
      const session = await sessionResponse.json();
      sessionId = String(session.id || session.session_id || '');
      if (!sessionId) throw apiError(502, 'session ID missing');
      const eventResponse = await this.request(`/sessions/${encodeURIComponent(sessionId)}/events`, {
        body: { events: [{ type: 'user.message', data: { text: String(prompt || '') } }] },
        accept: 'text/event-stream',
      });
      const text = parseQoderSse(await eventResponse.text());
      return { text, sessionId, latencyMs: Math.max(0, this.now() - startedAt) };
    } finally {
      if (sessionId) {
        await this.request(`/sessions/${encodeURIComponent(sessionId)}/archive`, { body: {} })
          .catch(() => {});
      }
    }
  }
}
