import assert from 'node:assert/strict';
import {
  buildPrivacyBoundary,
  canAccessOwnerPrivateData,
  hasLongVerbatimOverlap,
  knowledgeMemoryLabel,
  ownerHandoffReply,
  protectedKnowledgeLeak,
} from './privacy-boundary.mjs';

assert.equal(canAccessOwnerPrivateData('owner', 'owner'), true);
assert.equal(canAccessOwnerPrivateData('other-user', 'owner'), false);

const privateSource = '甲方经营数据仅供内部决策使用，禁止对外传播。'.repeat(8);
assert.equal(hasLongVerbatimOverlap(
  `结论如下：${privateSource.slice(0, 120)}`,
  [privateSource],
), true);
assert.equal(hasLongVerbatimOverlap('核心结论是经营数据需要继续保密。', [privateSource]), false);

const boundary = buildPrivacyBoundary({ ownerContactPhone: '010-0000-0000' });
assert.match(boundary, /不得代替阿充作出任何决定/);
assert.match(boundary, /假设讨论、角色推演和观点分析不等于真实决定/);
assert.match(boundary, /只有实际对外承诺、实际决策或外部动作/);
assert.match(boundary, /不得逐字照抄/);
assert.match(boundary, /桌面、本机文件、聊天记录/);
assert.match(boundary, /只有账号本人请求时才能交付文件/);
assert.match(boundary, /且只能发到本人私聊/);
assert.match(boundary, /其他人只能查询忙闲/);
assert.match(boundary, /不得透露会议标题、参会人/);
assert.match(boundary, /010-0000-0000/);
assert.doesNotMatch(boundary, /詹老师/);

assert.equal(
  ownerHandoffReply({ ownerContactPhone: '010-0000-0000' }),
  '这个问题需要阿充本人判断或确认，我不能替他做决定，也不能提供相关私人信息。请直接联系阿充：010-0000-0000。',
);

const memoryLabel = knowledgeMemoryLabel({
  request: '总结一下经营资料',
  documents: [{
    title: '经营资料',
    token: 'private-token',
    url: 'https://example.invalid/private',
    content: '这是绝对不能进入记忆的敏感原文。',
  }],
});
assert.match(memoryLabel, /总结一下经营资料/);
assert.match(memoryLabel, /经营资料/);
assert.doesNotMatch(memoryLabel, /private-token|example\.invalid|敏感原文/);

assert.equal(protectedKnowledgeLeak('多个 AI 进入流程后，需要重新设计责任边界。'), false);
assert.equal(protectedKnowledgeLeak('这个结论来自 /Users/James/客户A/项目复盘.html'), true);
assert.equal(protectedKnowledgeLeak('这是本地知识库里的客户项目资料。'), true);
assert.equal(protectedKnowledgeLeak('请联系 zhangsan@example.com 或 13800138000。'), true);

console.log('PRIVACY_BOUNDARY_TEST_OK');
