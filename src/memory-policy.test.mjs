import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateMemoryCandidate } from './memory-policy.mjs';
import { AgentState } from './state.mjs';

assert.deepEqual(
  validateMemoryCandidate({
    kind: 'project_fact',
    subject: '评测平台',
    content: 'ALT 平台能力',
    sourceRefs: ['local:alt'],
  }),
  { accepted: false, reason: 'excluded_scope' },
);
assert.deepEqual(
  validateMemoryCandidate({
    kind: 'product_method',
    subject: '需求写入',
    content: '需求写入后必须回读 1A 工作项',
    sourceRefs: ['user:confirmed'],
  }),
  { accepted: true, reason: '' },
);
assert.equal(validateMemoryCandidate({
  kind: 'preference', subject: '临时信息', content: '一次性口令 123456', sourceRefs: ['chat:1'],
}).accepted, false);
assert.equal(validateMemoryCandidate({
  kind: 'unknown', subject: '未知', content: '内容', sourceRefs: ['chat:1'],
}).accepted, false);

const directory = await mkdtemp(join(tmpdir(), 'james-memory-policy-'));
const state = new AgentState(join(directory, 'state.sqlite'));
try {
  state.upsertMemoryItem({
    memoryId: 'memory-1',
    kind: 'preference',
    subject: '表达方式',
    content: '直接、清晰、自然',
    sourceRefs: ['user:confirmed'],
    confidence: 'confirmed',
  });
  assert.equal(state.listActiveMemories('表达')[0].memoryId, 'memory-1');
  state.forgetMemory('memory-1');
  assert.equal(state.listActiveMemories('表达').length, 0);

  state.upsertKnowledgeSource({
    sourceId: 'repo:webagent',
    type: 'code_repository',
    title: 'WebAgent 代码仓库',
    locator: 'enterprise-development/ai-lab-agent',
    ownerId: '384351',
    status: 'active',
    sensitivity: 'internal',
  });
  assert.equal(state.getKnowledgeSource('repo:webagent').title, 'WebAgent 代码仓库');
} finally {
  state.close();
  await rm(directory, { recursive: true, force: true });
}

console.log('MEMORY_POLICY_TEST_OK');
