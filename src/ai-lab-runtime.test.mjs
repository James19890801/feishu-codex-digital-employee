import assert from 'node:assert/strict';
import * as aiRuntime from './ai-runtime.mjs';

const localCandidates = {
  codex: ['/missing/codex'],
  qoder: ['/missing/qoder'],
  codebuddy: ['/missing/codebuddy'],
  trae: ['/missing/trae'],
};

const unconfigured = aiRuntime.discoverAiRuntimes({
  candidates: localCandidates,
  installedCandidates: { trae: [] },
  isExecutable: () => false,
  aiLabConfigured: false,
});
assert.deepEqual(
  unconfigured.map(item => item.id),
  ['codex', 'qoder', 'codebuddy', 'trae', 'ai-lab'],
  'The runtime catalog must expose the internal AI-Lab runtime',
);
assert.equal(unconfigured.find(item => item.id === 'ai-lab').available, false);

const configured = aiRuntime.discoverAiRuntimes({
  candidates: localCandidates,
  installedCandidates: { trae: [] },
  isExecutable: () => false,
  aiLabConfigured: true,
});
assert.equal(configured.find(item => item.id === 'ai-lab').available, true);
assert.equal(aiRuntime.selectAiRuntime(configured, 'ai-lab').id, 'ai-lab');

const requests = [];
const ONLINE_DEBUG_WORK_NO = '384351';
const client = new aiRuntime.AiRuntimeClient({
  runtime: configured.find(item => item.id === 'ai-lab'),
  aiLab: {
    endpoint: 'https://pre-ai-lab-agent.alibaba-inc.com',
    agentId: 'agt_test123',
    apiKey: 'ak-test-secret',
    workNo: ONLINE_DEBUG_WORK_NO,
  },
  fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({
      run: { run_id: 'run_test', status: 'success' },
      values: {},
      messages: [{ role: 'assistant', content: '云端回复' }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  },
});
const result = await client.run('私密提示词', {
  cwd: '/tmp/ignored-by-ai-lab',
  timeoutMs: 30_000,
});
assert.equal(result.text, '云端回复');
assert.equal(requests.length, 1);
assert.equal(requests[0].url, 'https://pre-ai-lab-agent.alibaba-inc.com/api/runs/wait');
assert.equal(requests[0].options.headers.Authorization, 'Bearer ak-test-secret');
assert.equal(requests[0].options.headers.buc_user, JSON.stringify({ workNo: ONLINE_DEBUG_WORK_NO }));
assert.deepEqual(JSON.parse(requests[0].options.body), {
  agent_id: 'agt_test123',
  input: { messages: [{ role: 'user', content: '私密提示词' }] },
  if_not_exists: 'create',
  on_disconnect: 'continue',
  app_source: 'BACKEND',
  metadata: { source: 'aipr0s' },
});

assert.equal(typeof aiRuntime.normalizeAiLabRuntimeConfiguration, 'function');
const normalized = aiRuntime.normalizeAiLabRuntimeConfiguration({
  endpoint: 'https://pre-ai-lab-agent.alibaba-inc.com/',
  agentId: 'agt_test123',
  apiKey: 'ak-test-secret',
  workNo: '123456',
});
assert.deepEqual(normalized, {
  endpoint: 'https://pre-ai-lab-agent.alibaba-inc.com',
  agentId: 'agt_test123',
  apiKey: 'ak-test-secret',
  workNo: '123456',
});
assert.throws(
  () => aiRuntime.normalizeAiLabRuntimeConfiguration({ ...normalized, endpoint: 'http://example.com' }),
  /HTTPS endpoint/i,
);
assert.throws(
  () => aiRuntime.normalizeAiLabRuntimeConfiguration({ ...normalized, agentId: 'wrong' }),
  /Agent ID/i,
);
assert.throws(
  () => aiRuntime.normalizeAiLabRuntimeConfiguration({ ...normalized, apiKey: 'wrong' }),
  /API Key/i,
);
assert.throws(
  () => aiRuntime.normalizeAiLabRuntimeConfiguration({ ...normalized, workNo: 'abc' }),
  /work number/i,
);

console.log('AI_LAB_RUNTIME_TEST_OK');
