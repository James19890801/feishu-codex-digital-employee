import assert from 'node:assert/strict';
import { multicaRequestRoute } from './multica-request-routing.mjs';

assert.equal(
  multicaRequestRoute('帮我创建一个 Multica Issue，最后交付 PDF'),
  'multica',
  '创建 Issue 和交付物同时出现时，必须先创建 Issue',
);
assert.equal(
  multicaRequestRoute('把刚才那个任务最后生成 PDF 发我'),
  'artifact_followup',
  '没有新的 Multica 创建意图时才走已有任务交付物跟进',
);
assert.equal(multicaRequestRoute('MYS-12 的 PDF 做好了吗？'), 'artifact_followup');
assert.equal(multicaRequestRoute('创建一个 Multica Issue'), 'multica');
assert.equal(multicaRequestRoute('今天天气怎么样'), 'other');

console.log('MULTICA_REQUEST_ROUTING_TEST_OK');
