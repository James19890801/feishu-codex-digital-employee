import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildParityManifest } from './cloud-parity-manifest.mjs';
import { buildQoderSystem, syncQoderAgentPersona } from './qoder-agent-persona-sync.mjs';

const manifest = buildParityManifest({ persona: 'PERSONA-CONTENT', bible: 'BIBLE-CONTENT',
  instructions: 'INSTRUCTIONS-CONTENT', state: { relationship_fact: [{ fact_id: 'private-memory',
    content: 'NOT-FOR-SYSTEM-PROMPT' }] } });

test('Qoder system includes policy documents, excludes memory and cannot authorize sending', () => {
  const system = buildQoderSystem(manifest);
  for (const value of ['PERSONA-CONTENT', 'BIBLE-CONTENT', 'INSTRUCTIONS-CONTENT']) {
    assert.ok(system.includes(value));
  }
  assert.ok(system.includes('只生成候选答复'));
  assert.equal(system.includes('NOT-FOR-SYSTEM-PROMPT'), false);
});

test('unchanged Agent prompt is read-only and an update pins a new version with tools disabled', async () => {
  const system = buildQoderSystem(manifest);
  const calls = [];
  let current = { version: 2, system, tools: [] };
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method || 'GET', body: options.body });
    if (options.method === 'POST') {
      const body = JSON.parse(options.body);
      assert.equal(body.version, 2);
      assert.deepEqual(body.tools, []);
      current = { ...current, ...body, version: 3 };
    }
    return { ok: true, status: 200, json: async () => current };
  };
  const params = { manifest, pat: 'test-pat', agentId: 'agent_test', fetchImpl };
  assert.deepEqual(await syncQoderAgentPersona(params), { changed: false, version: 2 });
  assert.deepEqual(calls.map(call => call.method), ['GET']);
  current = { ...current, system: 'old' };
  assert.deepEqual(await syncQoderAgentPersona(params), { changed: true, version: 3 });
  assert.deepEqual(calls.map(call => call.method), ['GET', 'GET', 'POST']);
});

test('Agent API failure or malformed version fails closed', async () => {
  const params = { manifest, pat: 'test-pat', agentId: 'agent_test' };
  await assert.rejects(syncQoderAgentPersona({ ...params,
    fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) }), /qoder_agent_http_401/);
  await assert.rejects(syncQoderAgentPersona({ ...params,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ version: 'bad' }) }) }), /invalid_qoder_agent/);
});
