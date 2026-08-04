import assert from 'node:assert/strict';
import { buildKnowledgeInventory } from './build-knowledge-inventory.mjs';

const secret = ['sk', 'abcdefghijklmnopqrstuvwxyz123456'].join('-');
const catalog = buildKnowledgeInventory([
  {
    sourceId: 'repo:webagent', type: 'code_repository', title: 'WebAgent 代码仓库',
    locator: 'enterprise-development/ai-lab-agent', domain: 'webagent', approved: true,
    ownerId: '384351', summary: 'WebAgent 实现事实来源。', raw: '不得保留的原文',
  },
  {
    sourceId: 'repo:webagent-copy', type: 'code_repository', title: '重复仓库',
    locator: 'enterprise-development/ai-lab-agent', domain: 'webagent', approved: true,
    summary: '重复。',
  },
  {
    sourceId: 'excluded-platform', type: 'dingtalk_doc', title: 'ALT 方案', locator: 'doc-1',
    domain: 'webagent', approved: true, summary: '不应进入。',
  },
  {
    sourceId: 'private-chat', type: 'dingtalk_chat', title: '私人聊天', locator: 'chat-1',
    domain: 'personal', approved: false, summary: '和产品无关。',
  },
  {
    sourceId: 'secret-doc', type: 'local_document', title: 'WebAgent 密钥', locator: 'doc-2',
    domain: 'webagent', approved: true, summary: `token=${secret}`,
  },
  {
    sourceId: 'a1:webagent', type: 'a1_workitem', title: 'WebAgent需求池',
    locator: 'a1:project:2165415', domain: 'webagent', approved: true,
    ownerId: '384351', summary: '实时需求来源。', freshnessAt: '2026-08-03',
  },
]);

assert.equal(catalog.version, 2);
assert.deepEqual(catalog.sources.map(item => item.sourceId), ['a1:webagent', 'repo:webagent']);
assert.equal(JSON.stringify(catalog).includes('raw'), false);
assert.equal(JSON.stringify(catalog).includes(secret), false);
assert.equal(JSON.stringify(catalog).includes('ALT'), false);

console.log('build-knowledge-inventory tests passed');
