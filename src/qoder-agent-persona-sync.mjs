const QODER_BASE = 'https://api.qoder.com.cn/api/v1/cloud';
const CLOUD_ROLE = '你是本人的云端备用数字员工。以下文档按顺序共同约束候选答复。所有渠道入站准入、黑白名单、真人接管、本人确认、出站发送和回执由外部协调器裁决；你只生成候选答复，不自行发送，不宣称已执行未验证的动作。不能完成的能力明确说明。';

export function buildQoderSystem(manifest) {
  if (manifest?.version !== 1 || !manifest.sections) throw new Error('invalid_parity_manifest');
  const parts = [['PERSONA', 'persona'], ['BIBLE', 'bible'], ['AGENTS', 'instructions']]
    .map(([label, key]) => {
      const content = manifest.sections[key]?.data;
      if (typeof content !== 'string') throw new Error('invalid_parity_document');
      return `<${label}>\n${content}\n</${label}>`;
    });
  const system = [CLOUD_ROLE, ...parts].join('\n\n');
  if (system.length > 100_000) throw new Error('qoder_system_too_long');
  return system;
}

export async function syncQoderAgentPersona({ manifest, pat, agentId, fetchImpl = fetch } = {}) {
  if (typeof pat !== 'string' || !pat || !/^agent_[A-Za-z0-9_-]{1,80}$/.test(agentId || '')) {
    throw new Error('invalid_qoder_agent_configuration');
  }
  const system = buildQoderSystem(manifest);
  const url = `${QODER_BASE}/agents/${encodeURIComponent(agentId)}`;
  const headers = { authorization: `Bearer ${pat}`, 'content-type': 'application/json' };
  async function request(method, body) {
    const response = await fetchImpl(url, { method, headers,
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`qoder_agent_http_${response.status}`);
    const result = await response.json();
    if (!Number.isSafeInteger(result?.version) || result.version < 1) {
      throw new Error('invalid_qoder_agent');
    }
    return result;
  }
  const current = await request('GET');
  if (current.system === system && Array.isArray(current.tools) && current.tools.length === 0) {
    return { changed: false, version: current.version };
  }
  const updated = await request('POST', { version: current.version, system, tools: [] });
  if (updated.version <= current.version || updated.system !== system
    || !Array.isArray(updated.tools) || updated.tools.length !== 0) {
    throw new Error('qoder_agent_update_not_verified');
  }
  return { changed: true, version: updated.version };
}
