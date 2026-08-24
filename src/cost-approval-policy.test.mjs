import assert from 'node:assert/strict';
import {
  classifyHighCostRequest,
  requiresOwnerCostApproval,
} from './cost-approval-policy.mjs';

for (const [request, category] of [
  ['用这张头像做个跳舞的视频', 'media_generation'],
  ['帮我生成一张企业架构海报', 'media_generation'],
  ['把背景换成蓝色并生成图片', 'media_generation'],
  ['把分析结果做成 PDF 发给我', 'artifact_generation'],
  ['请输出一份 PPTX', 'artifact_generation'],
  ['写一份完整的行业调研报告', 'long_report'],
  ['生成一份 AI 在 HR 领域应用外部对标报告', 'long_report'],
  ['撰写具身智能法律合规白皮书', 'long_report'],
]) {
  const result = classifyHighCostRequest(request);
  assert.equal(result.required, true, request);
  assert.equal(result.category, category, request);
  assert.ok(result.summary.length > 0, request);
}

for (const request of [
  '读一下这张图片，指出逻辑错误',
  '总结一下这份报告的三个观点',
  '解释什么是企业智能体架构',
  '给我一个五点提纲',
  '这个 PDF 讲了什么？',
  '看看视频里发生了什么',
]) {
  assert.equal(classifyHighCostRequest(request).required, false, request);
}

assert.equal(requiresOwnerCostApproval({
  request: '生成一份完整报告',
  ownerAuthorized: false,
}), true);
assert.equal(requiresOwnerCostApproval({
  request: '生成一份完整报告',
  ownerAuthorized: true,
}), false);
assert.equal(requiresOwnerCostApproval({
  request: '总结一下这份报告',
  ownerAuthorized: false,
}), false);

console.log('COST_APPROVAL_POLICY_TEST_OK');
