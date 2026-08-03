import assert from 'node:assert/strict';
import {
  buildA1SpecPrompt,
  extractRepositoryPaths,
  parseA1RequirementSpec,
} from './a1-spec-planner.mjs';

const prompt = buildA1SpecPrompt({
  request: '支持支付',
  route: { productName: 'WebAgent', repo: 'enterprise-development/ai-lab-agent' },
  clarification: '支付宝和银行卡',
  existingBody: '# old',
  repositoryEvidence: 'src/pay.ts',
});
assert.match(prompt, /只输出 JSON/);
assert.match(prompt, /WebAgent/);
assert.match(prompt, /支付宝和银行卡/);

const spec = parseA1RequirementSpec(JSON.stringify({
  title: '支持支付流程',
  background: '当前缺少支付能力。',
  goals: ['完成支付闭环'],
  requirements: [{ name: '支付方式', detail: '支持支付宝和银行卡。', priority: 'P0' }],
  codeEvidence: [{ path: 'src/pay.ts', finding: '支付入口。' }],
  acceptanceCriteria: ['两种方式均可支付'],
  risks: ['权限校验'],
  openQuestions: [],
  codeSearchTerms: ['payment'],
}));
assert.equal(spec.requirements.length, 1);
assert.equal(spec.codeSearchTerms[0], 'payment');
assert.throws(() => parseA1RequirementSpec('```json\n{}\n```'), /JSON/);
assert.throws(() => parseA1RequirementSpec(JSON.stringify({ title: 'ALT 登录' })), /ALT|background/);

assert.deepEqual(extractRepositoryPaths({
  data: [{ filePath: 'src/pay.ts' }, { path: 'README.md' }, { path: '../secret' }],
}), ['src/pay.ts', 'README.md']);

console.log('a1-spec-planner tests passed');
