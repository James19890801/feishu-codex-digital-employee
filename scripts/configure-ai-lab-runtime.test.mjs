import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as configure from './configure-ai-lab-runtime.mjs';

assert.equal(typeof configure.applyAiLabRuntimeConfiguration, 'function');

const root = await mkdtemp(join(tmpdir(), 'aipr0s-ai-lab-config-'));
await mkdir(join(root, 'data'), { recursive: true });
await Promise.all([
  writeFile(join(root, 'config.local.json'), '{"aiRuntime":"qoder","preserved":true}\n'),
  writeFile(join(root, 'PERSONA.md'), 'persona\n'),
  writeFile(join(root, 'BIBLE.md'), 'bible\n'),
  writeFile(join(root, 'knowledge-catalog.json'), '[]\n'),
]);

const result = await configure.applyAiLabRuntimeConfiguration({
  root,
  input: {
    endpoint: 'https://pre-ai-lab-agent.alibaba-inc.com',
    agentId: 'agt_test123',
    apiKey: 'ak-test-secret',
    workNo: '123456',
  },
});
const applied = JSON.parse(await readFile(join(root, 'config.local.json'), 'utf8'));
assert.equal(applied.preserved, true);
assert.equal(applied.aiRuntime, 'ai-lab');
assert.equal(applied.aiLabAgentId, 'agt_test123');
assert.equal(applied.aiLabApiKey, 'ak-test-secret');
assert.equal(applied.aiLabWorkNo, '123456');
assert.equal((await stat(join(root, 'config.local.json'))).mode & 0o777, 0o600);
assert.equal(result.configured, true);
assert.equal(result.backupId.startsWith('snapshot-'), true);

console.log('CONFIGURE_AI_LAB_RUNTIME_TEST_OK');
