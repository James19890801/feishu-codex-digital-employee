import assert from 'node:assert/strict';
import { prepareRequirementWithRepositoryEvidence } from './a1-requirement-preparer.mjs';

const route = {
  productName: 'WebAgent', inspectRepository: true,
  repo: 'enterprise-development/ai-lab-agent', branch: '',
};

{
  let planCalls = 0;
  const result = await prepareRequirementWithRepositoryEvidence({ request: '下拉框组件', route }, {
    planRequirement: async input => {
      planCalls += 1;
      return {
        title: '需求澄清下拉框', codeSearchTerms: ['需求澄清'], codeEvidence: [],
        risks: [], repositoryEvidence: input.repositoryEvidence,
      };
    },
    searchRepository: async () => { throw new Error('网络超时，请重试'); },
    viewRepositoryFile: async () => { throw new Error('must not read files'); },
    extractPaths: () => [],
  });
  assert.equal(planCalls, 1);
  assert.deepEqual(result.codeEvidence, []);
  assert.match(result.risks.join('\n'), /代码检索未完成.*网络超时/u);
}

{
  let planCalls = 0;
  const result = await prepareRequirementWithRepositoryEvidence({ request: '下拉框组件', route }, {
    planRequirement: async input => {
      planCalls += 1;
      return {
        title: '需求澄清下拉框', codeSearchTerms: ['需求澄清'],
        codeEvidence: input.repositoryEvidence ? [{ path: 'src/input.tsx', finding: '入口' }] : [],
        risks: [],
      };
    },
    searchRepository: async () => ({ search: [{ path: 'src/input.tsx' }], tree: [] }),
    viewRepositoryFile: async () => 'export const Input = () => null;',
    extractPaths: value => value.map(item => item.path),
  });
  assert.equal(planCalls, 2);
  assert.deepEqual(result.codeEvidence, [{ path: 'src/input.tsx', finding: '入口' }]);
}

console.log('a1-requirement-preparer tests passed');
