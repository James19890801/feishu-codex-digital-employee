const BASE_URL = 'https://api.qoder.com.cn/api/v1/cloud';
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const CONTEXT_KEYS = new Set(['persona', 'rules', 'thread', 'history']);
const DIGEST = /^[a-f0-9]{64}$/;

function failure(code, status) {
  return Object.assign(new Error(code), { code, ...(status ? { status } : {}) });
}

function checkedContext(input) {
  if (input === undefined) return {};
  if (!input || Array.isArray(input) || typeof input !== 'object') throw failure('invalid_context');
  const output = {};
  for (const [key, value] of Object.entries(input)) {
    if (!CONTEXT_KEYS.has(key) || typeof value !== 'string' || value.length > 32_000) {
      throw failure('unsupported_context');
    }
    output[key] = value;
  }
  if (Buffer.byteLength(JSON.stringify(output)) > 64 * 1024) throw failure('context_too_large');
  return output;
}

function eventText(data) {
  const value = data?.content ?? data?.message?.content ?? data?.text;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(item => typeof item === 'string' ? item : item?.text || '').join('');
  return '';
}

function parseEvents(body) {
  const events = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    let id = '';
    let type = '';
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('id:')) id = line.slice(3).trim();
      else if (line.startsWith('event:')) type = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!type) continue;
    let data = {};
    if (dataLines.length) {
      try { data = JSON.parse(dataLines.join('\n')); }
      catch { throw failure('qoder_invalid_sse'); }
    }
    events.push({ id, type, data });
  }
  return events;
}

async function* readEvents(response, maxBytes) {
  if (!response.body) {
    const body = await response.text();
    if (Buffer.byteLength(body) > maxBytes) throw failure('qoder_response_too_large');
    yield* parseEvents(body);
    return;
  }
  const decoder = new TextDecoder();
  let pending = '';
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw failure('qoder_response_too_large');
    pending += decoder.decode(chunk, { stream: true });
    let separator = pending.search(/\r?\n\r?\n/);
    while (separator >= 0) {
      const block = pending.slice(0, separator);
      const match = pending.slice(separator).match(/^\r?\n\r?\n/);
      pending = pending.slice(separator + match[0].length);
      yield* parseEvents(`${block}\n\n`);
      separator = pending.search(/\r?\n\r?\n/);
    }
  }
  pending += decoder.decode();
  if (pending.trim()) yield* parseEvents(`${pending}\n\n`);
}

export class QoderManagedRuntime {
  constructor({ agentId, environmentId, agentVersion, patSupplier, fetchImpl = fetch,
    delay = ms => new Promise(resolve => setTimeout(resolve, ms)), baseUrl = BASE_URL,
    timeoutMs = 180_000, maxSseBytes = 2 * 1024 * 1024 } = {}) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(agentId || '')
      || !/^[A-Za-z0-9_-]{1,128}$/.test(environmentId || '')
      || !Number.isInteger(agentVersion) || agentVersion < 1
      || typeof patSupplier !== 'function') throw new TypeError('Qoder managed runtime configuration required');
    this.agentId = agentId;
    this.environmentId = environmentId;
    this.agentVersion = agentVersion;
    this.patSupplier = patSupplier;
    this.fetchImpl = fetchImpl;
    this.delay = delay;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
    this.maxSseBytes = maxSseBytes;
  }

  async request(path, { method = 'POST', body, accept = 'application/json', lastEventId } = {}) {
    const pat = await this.patSupplier();
    if (!pat || typeof pat !== 'string') throw failure('qoder_pat_unavailable');
    const payload = body === undefined ? undefined : JSON.stringify(body);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let response;
      let timer;
      try {
        response = await Promise.race([
          this.fetchImpl(`${this.baseUrl}${path}`, { method, body: payload,
            headers: { authorization: `Bearer ${pat}`, accept,
              ...(payload ? { 'content-type': 'application/json' } : {}),
              ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}) },
            signal: AbortSignal.timeout(this.timeoutMs) }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(failure('qoder_timeout')), this.timeoutMs); }),
        ]);
      } catch (error) {
        if (attempt === 3 || error?.code === 'qoder_timeout') throw failure('qoder_unreachable');
        await this.delay(2 ** attempt * 1000);
        continue;
      } finally {
        clearTimeout(timer);
      }
      if (response.ok) return response;
      if (!RETRYABLE.has(response.status) || attempt === 3) throw failure('qoder_api_error', response.status);
      await this.delay(2 ** attempt * 1000);
    }
    throw failure('qoder_unreachable');
  }

  async execute({ message, policyDigest, context } = {}) {
    if (typeof message !== 'string' || !message.trim() || message.length > 16_000
      || !DIGEST.test(policyDigest || '')) throw failure('invalid_qoder_input');
    const scoped = checkedContext(context);
    const text = [message, ...Object.entries(scoped).map(([key, value]) => `[${key}]\n${value}`)].join('\n\n');
    let sessionId;
    try {
      const sessionResponse = await this.request('/sessions', { body: {
        agent: { id: this.agentId, type: 'agent', version: this.agentVersion },
        environment_id: this.environmentId,
        metadata: { policy_digest: policyDigest },
      } });
      const session = await sessionResponse.json();
      sessionId = session.id || session.session_id;
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId || '')) throw failure('qoder_missing_session');
      await this.request(`/sessions/${sessionId}/events`, { body: {
        events: [{ type: 'user.message', content: [{ type: 'text', text }] }],
      } });
      const seen = new Set();
      const messages = [];
      let lastEventId = '';
      for (let reconnect = 0; reconnect < 3; reconnect += 1) {
        const response = await this.request(`/sessions/${sessionId}/events/stream`, {
          method: 'GET', accept: 'text/event-stream', lastEventId,
        });
        for await (const event of readEvents(response, this.maxSseBytes)) {
          if (!event.id) throw failure('qoder_event_id_missing');
          if (seen.has(event.id)) continue;
          seen.add(event.id);
          lastEventId = event.id;
          if (event.type === 'agent.custom_tool_use' || event.type === 'agent.tool_use'
            || event.type.includes('requires_action')) throw failure('qoder_tool_not_authorized');
          if (event.type === 'agent.message') {
            const chunk = eventText(event.data);
            if (chunk) messages.push(chunk);
          }
          if (event.type === 'session.status_idle') {
            const answer = messages.join('').trim();
            if (!answer) throw failure('qoder_empty_response');
            return { text: answer, sessionId };
          }
        }
        if (!lastEventId) throw failure('qoder_stream_incomplete');
      }
      throw failure('qoder_stream_incomplete');
    } finally {
      if (sessionId) await this.request(`/sessions/${sessionId}/archive`, { body: {} }).catch(() => {});
    }
  }
}
