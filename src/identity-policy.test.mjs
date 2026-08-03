import assert from 'node:assert/strict';
import {
  ACTIVE_IDENTITY,
  buildIdentityInstruction,
  isExcludedIdentityText,
  sanitizeIdentityContext,
} from './identity-policy.mjs';

assert.equal(ACTIVE_IDENTITY, '阿充，AI 产品经理');
assert.equal(isExcludedIdentityText('这是 ALT 平台的需求'), true);
assert.equal(isExcludedIdentityText('我是詹老师的开发者'), true);
assert.equal(isExcludedIdentityText('WebAgent 需求分析'), false);

assert.equal(sanitizeIdentityContext('我是 James，也是开发者'), '我是，也是');
assert.equal(
  sanitizeIdentityContext('师姐，我满四周年啦。——阿充（James）', { allowJamesSignature: true }),
  '师姐，我满四周年啦。——阿充（James）',
);
assert.equal(
  sanitizeIdentityContext('我是 James', { allowJamesSignature: true }),
  '我是',
);

const instruction = buildIdentityInstruction();
assert.match(instruction, /阿充在本企业的唯一现行身份是 AI 产品经理/);
assert.doesNotMatch(instruction, /ALT|James|詹老师|AIPRO/);
assert.match(instruction, /被排除的业务上下文/);

console.log('IDENTITY_POLICY_TEST_OK');
