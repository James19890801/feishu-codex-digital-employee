import assert from 'node:assert/strict';
import {
  buildIdentityInstruction,
  isExcludedIdentityText,
  sanitizeIdentityContext,
} from './identity-policy.mjs';

assert.equal(isExcludedIdentityText('这是 ALT 平台的需求'), true);
assert.equal(isExcludedIdentityText('WebAgent 需求分析'), false);

assert.equal(sanitizeIdentityContext('这是 ALT 平台需求'), '这是 平台需求');

const instruction = buildIdentityInstruction({
  displayName: '新用户',
  role: '产品经理',
});
assert.match(instruction, /你是新用户的数字人/);
assert.match(instruction, /新用户在本企业的现行角色是产品经理/);
assert.doesNotMatch(instruction, /阿充|James|詹老师|AIPRO/);
assert.match(instruction, /被排除的业务上下文/);

console.log('IDENTITY_POLICY_TEST_OK');
