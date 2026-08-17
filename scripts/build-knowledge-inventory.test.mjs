import assert from 'node:assert/strict';
import { buildKnowledgeInventory } from './build-knowledge-inventory.mjs';

const secret = ['sk', 'abcdefghijklmnopqrstuvwxyz123456'].join('-');
const catalog = buildKnowledgeInventory([
  {
    sourceId: 'repo:webagent', type: 'code_repository', title: 'WebAgent 代码仓库',
    locator: 'example-org/example-repository', domain: 'webagent', approved: true,
    ownerId: 'owner-demo', summary: 'WebAgent 实现事实来源。', raw: '不得保留的原文',
  },
  {
    sourceId: 'repo:webagent-copy', type: 'code_repository', title: '重复仓库',
    locator: 'example-org/example-repository', domain: 'webagent', approved: true,
    summary: '重复。',
  },
  {
    sourceId: 'excluded-platform', type: 'enterpriseChat_doc', title: 'ALT 方案', locator: 'doc-1',
    domain: 'webagent', approved: true, summary: '不应进入。',
  },
  {
    sourceId: 'private-chat', type: 'enterpriseChat_chat', title: '私人聊天', locator: 'chat-1',
    domain: 'personal', approved: false, summary: '和产品无关。',
  },
  {
    sourceId: 'secret-doc', type: 'local_document', title: 'WebAgent 密钥', locator: 'doc-2',
    domain: 'webagent', approved: true, summary: `token=${secret}`,
  },
  {
    sourceId: 'multica:demo', type: 'multica_issue', title: 'Demo project backlog',
    locator: 'multica:workspace:demo', domain: 'webagent', approved: true,
    ownerId: '', summary: 'Project issue source.', freshnessAt: '2026-08-17',
  },
]);

assert.equal(catalog.version, 2);
assert.deepEqual(catalog.sources.map(item => item.sourceId), ['multica:demo', 'repo:webagent']);
assert.equal(JSON.stringify(catalog).includes('raw'), false);
assert.equal(JSON.stringify(catalog).includes(secret), false);
assert.equal(JSON.stringify(catalog).includes('ALT'), false);

console.log('build-knowledge-inventory tests passed');
