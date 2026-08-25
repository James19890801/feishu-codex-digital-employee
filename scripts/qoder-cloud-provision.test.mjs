import assert from 'node:assert/strict';
import { QoderProvisioner } from './qoder-cloud-provision.mjs';

const calls = [];
const fetchImpl = async (url, options) => {
  const path = new URL(url).pathname + new URL(url).search;
  calls.push({ path, method: options.method, headers: options.headers,
    body: options.body ? JSON.parse(options.body) : null });
  if (path.endsWith('/models?limit=100')) return Response.json({ data: [{ id: 'ultimate', is_enabled: true }] });
  if (path.endsWith('/environments?limit=100')) return Response.json({ data: [] });
  if (path.endsWith('/agents?limit=100')) return Response.json({ data: [] });
  if (path.endsWith('/environments')) return Response.json({ id: 'env_test', name: 'aipros-cloud-failover' });
  if (path.endsWith('/agents')) return Response.json({ id: 'agent_test', version: 3, name: 'aipros-cloud-failover' });
  return new Response('not found', { status: 404 });
};
const result = await new QoderProvisioner({ pat: 'secret', fetchImpl, delay: async () => {} }).provision();
assert.deepEqual(result, {
  agentId: 'agent_test', agentVersion: 3, environmentId: 'env_test', model: 'ultimate',
  agentCreated: true, environmentCreated: true,
});
const agentCreate = calls.find(call => call.path.endsWith('/agents') && call.method === 'POST');
assert.deepEqual(agentCreate.body.tools, []);
assert.deepEqual(agentCreate.body.mcp_servers, []);
assert.deepEqual(agentCreate.body.skills, []);
assert.match(agentCreate.headers['idempotency-key'], /^aipros-agent-/);
const environmentCreate = calls.find(call => call.path.endsWith('/environments') && call.method === 'POST');
assert.equal(environmentCreate.body.config.networking.type, 'limited');
assert.deepEqual(environmentCreate.body.config.packages, { apt: [], pip: [], npm: [] });
assert.match(environmentCreate.headers['idempotency-key'], /^aipros-environment-/);

const driftedFetch = async url => {
  const path = new URL(url).pathname + new URL(url).search;
  if (path.endsWith('/models?limit=100')) return Response.json({ data: [{ id: 'ultimate', is_enabled: true }] });
  if (path.endsWith('/environments?limit=100')) return Response.json({ data: [{
    id: 'env_existing', name: 'aipros-cloud-failover',
    config: { type: 'cloud', networking: { type: 'limited' }, packages: { apt: [], pip: [], npm: [] } },
  }] });
  if (path.endsWith('/agents?limit=100')) return Response.json({ data: [{
    id: 'agent_existing', version: 9, name: 'aipros-cloud-failover', model: 'ultimate',
    tools: [{ type: 'agent_toolset_20260401', enabled_tools: ['Bash'] }],
    mcp_servers: [], skills: [], metadata: { boundary: 'l0_l1_only' },
  }] });
  return new Response('not found', { status: 404 });
};
await assert.rejects(
  () => new QoderProvisioner({ pat: 'secret', fetchImpl: driftedFetch }).provision(),
  /unsafe tools/i,
);

const pagedFetch = async url => {
  const parsed = new URL(url);
  const path = parsed.pathname + parsed.search;
  if (path.endsWith('/models?limit=100')) return Response.json({ data: [{ id: 'ultimate', is_enabled: true }] });
  if (path.endsWith('/environments?limit=100')) {
    return Response.json({ data: [], has_more: true, next_page: 'env_cursor' });
  }
  if (path.endsWith('/environments?limit=100&page=env_cursor')) return Response.json({ data: [{
    id: 'env_paged', name: 'aipros-cloud-failover',
    config: { type: 'cloud', networking: { type: 'limited' }, packages: { apt: [], pip: [], npm: [] } },
  }], has_more: false });
  if (path.endsWith('/agents?limit=100')) {
    return Response.json({ data: [], has_more: true, next_page: 'agent_cursor' });
  }
  if (path.endsWith('/agents?limit=100&page=agent_cursor')) return Response.json({ data: [{
    id: 'agent_paged', version: 4, name: 'aipros-cloud-failover', model: 'ultimate',
    tools: [], mcp_servers: [], skills: [], metadata: { boundary: 'l0_l1_only' },
  }], has_more: false });
  return new Response('unexpected request', { status: 500 });
};
const paged = await new QoderProvisioner({ pat: 'secret', fetchImpl: pagedFetch }).provision();
assert.equal(paged.agentId, 'agent_paged');
assert.equal(paged.environmentId, 'env_paged');
assert.equal(paged.agentCreated, false);
assert.equal(paged.environmentCreated, false);
console.log('QODER_CLOUD_PROVISION_TEST_OK');
