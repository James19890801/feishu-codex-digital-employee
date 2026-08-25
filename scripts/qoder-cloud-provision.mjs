import { createHash } from 'node:crypto';

const BASE_URL = 'https://api.qoder.com/api/v1/cloud';
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

function emptyList(value) { return Array.isArray(value) && value.length === 0; }

function idempotencyKey(kind, name) {
  return `aipros-${kind}-${createHash('sha256').update(String(name)).digest('hex').slice(0, 32)}`;
}

function validateRestrictedEnvironment(environment) {
  const packages = environment?.config?.packages || {};
  if (environment?.config?.type !== 'cloud'
    || environment?.config?.networking?.type !== 'limited'
    || !emptyList(packages.apt) || !emptyList(packages.pip) || !emptyList(packages.npm)) {
    throw new Error('Existing Qoder environment is not restricted');
  }
}

function validateToolFreeAgent(agent, modelId) {
  if (!emptyList(agent?.tools)) throw new Error('Existing Qoder agent has unsafe tools');
  if (!emptyList(agent?.mcp_servers)) throw new Error('Existing Qoder agent has unsafe MCP servers');
  if (!emptyList(agent?.skills)) throw new Error('Existing Qoder agent has unsafe skills');
  if (agent?.model !== modelId || agent?.metadata?.boundary !== 'l0_l1_only') {
    throw new Error('Existing Qoder agent does not match the restricted boundary');
  }
}

export class QoderProvisioner {
  constructor({ pat, fetchImpl = globalThis.fetch, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    this.pat = String(pat || '');
    this.fetchImpl = fetchImpl;
    this.delay = delay;
    if (!this.pat) throw new TypeError('QODER_PAT is required');
  }

  async request(path, { method = 'GET', body, idempotencyKey: requestKey } = {}) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await this.fetchImpl(`${BASE_URL}${path}`, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: {
          authorization: `Bearer ${this.pat}`,
          accept: 'application/json',
          ...(requestKey ? { 'idempotency-key': requestKey } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
      });
      if (response.ok) return response.json();
      const errorBody = await response.text().catch(() => '');
      if (!RETRYABLE.has(response.status) || attempt === 3) {
        const error = new Error(`Qoder API ${response.status}: ${errorBody.slice(0, 200)}`);
        error.status = response.status;
        throw error;
      }
      await this.delay(2 ** attempt * 1_000);
    }
    throw new Error('Qoder retry limit reached');
  }

  async findByName(path, name) {
    let pageCursor = '';
    for (let page = 0; page < 1_000; page += 1) {
      const suffix = pageCursor ? `&page=${encodeURIComponent(pageCursor)}` : '';
      const result = await this.request(`${path}?limit=100${suffix}`);
      const found = (Array.isArray(result.data) ? result.data : [])
        .find(item => item.name === name && item.archived !== true);
      if (found) return found;
      if (!result.has_more) return null;
      const next = String(result.next_page || '');
      if (!next || next === pageCursor) throw new Error(`Qoder pagination stalled for ${path}`);
      pageCursor = next;
    }
    throw new Error(`Qoder pagination exceeded safety limit for ${path}`);
  }

  async provision({
    agentName = 'aipros-cloud-failover',
    environmentName = 'aipros-cloud-failover',
  } = {}) {
    const models = await this.request('/models?limit=100');
    const enabledModels = (models.data || []).filter(model => model.is_enabled !== false);
    const model = enabledModels.find(item => item.id === 'ultimate') || enabledModels[0];
    if (!model?.id) throw new Error('No enabled Qoder model is available');

    let environment = await this.findByName('/environments', environmentName);
    let environmentCreated = false;
    if (!environment) {
      environment = await this.request('/environments', {
        method: 'POST',
        idempotencyKey: idempotencyKey('environment', environmentName),
        body: {
          name: environmentName,
          description: 'Restricted environment for AIPR0S text-only L0/L1 failover.',
          config: {
            type: 'cloud',
            networking: { type: 'limited' },
            packages: { apt: [], pip: [], npm: [] },
          },
          metadata: { product: 'aipros', purpose: 'cloud_failover' },
        },
      });
      environmentCreated = true;
    } else validateRestrictedEnvironment(environment);

    let agent = await this.findByName('/agents', agentName);
    let agentCreated = false;
    if (!agent) {
      agent = await this.request('/agents', {
        method: 'POST',
        idempotencyKey: idempotencyKey('agent', agentName),
        body: {
          name: agentName,
          description: 'Tool-free AIPR0S cloud fallback for text-only L0/L1 replies.',
          model: model.id,
          system: [
            'You are the restricted cloud fallback for a local-first personal digital human.',
            'Reply concisely in Simplified Chinese unless the user clearly requests another language.',
            'Only answer, summarize, rewrite, or draft text.',
            'Never claim to have used tools, accessed files, sent messages, or changed external state.',
            'For payments, contracts, hiring, deletion, credentials, commitments, or real mutations, require owner confirmation.',
          ].join(' '),
          tools: [],
          mcp_servers: [],
          skills: [],
          metadata: { product: 'aipros', purpose: 'cloud_failover', boundary: 'l0_l1_only' },
        },
      });
      agentCreated = true;
    } else validateToolFreeAgent(agent, model.id);

    const version = Number(agent.version || 0);
    if (!String(agent.id || '').startsWith('agent_')
      || !String(environment.id || '').startsWith('env_')
      || !Number.isInteger(version) || version < 0) {
      throw new Error('Qoder returned invalid Agent or Environment metadata');
    }
    return {
      agentId: agent.id,
      agentVersion: version,
      environmentId: environment.id,
      model: model.id,
      agentCreated,
      environmentCreated,
    };
  }
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const result = await new QoderProvisioner({ pat: process.env.QODER_PAT }).provision();
  console.log(JSON.stringify(result, null, 2));
}
