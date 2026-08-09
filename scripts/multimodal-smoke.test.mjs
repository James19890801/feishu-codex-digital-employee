import assert from 'node:assert/strict';
import { buildMultimodalSmokePlan, redactSmokePlan } from './multimodal-smoke.mjs';

const plan = buildMultimodalSmokePlan({
  workspaceRoot: '/workspace',
  channels: ['feishu', 'dingtalk'],
  feishuChatId: 'oc_test_group',
  dingtalkChatId: 'dingtalk:group:cid-test',
  files: [
    '/workspace/outputs/smoke/report.pdf',
    '/workspace/outputs/smoke/chart.png',
  ],
});
assert.equal(plan.length, 4);
assert.ok(plan[0].args.includes('--file'));
assert.ok(plan[1].args.includes('--image'));
assert.ok(plan[2].args.includes('--group'));
assert.ok(plan[2].args.includes('cid-test'));

const redacted = JSON.stringify(redactSmokePlan(plan));
assert.equal(redacted.includes('oc_test_group'), false);
assert.equal(redacted.includes('cid-test'), false);
assert.match(redacted, /<configured-test-target>/);

assert.throws(() => buildMultimodalSmokePlan({
  workspaceRoot: '/workspace',
  channels: ['feishu'],
  files: ['/workspace/outputs/smoke/report.pdf'],
}), /Feishu test chat/i);

assert.throws(() => buildMultimodalSmokePlan({
  workspaceRoot: '/workspace',
  channels: ['dingtalk'],
  dingtalkChatId: 'dingtalk:group:cid-test',
  files: ['/tmp/secret.pdf'],
}), /workspace/i);

console.log('MULTIMODAL_SMOKE_TEST_OK');
