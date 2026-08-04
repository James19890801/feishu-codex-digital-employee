import assert from 'node:assert/strict';
import {
  buildRequirementBody,
  classifyRequirementIntent,
  resolveProductRoute,
} from './a1-requirements.mjs';

assert.deepEqual(resolveProductRoute('WebAgent'), {
  key: 'webagent',
  productName: 'WebAgent',
  projectId: '2165415',
  projectName: 'WebAgent需求池',
  repo: 'enterprise-development/ai-lab-agent',
  branch: '',
  inspectRepository: true,
  classificationPending: false,
  needsClarification: false,
});

assert.deepEqual(resolveProductRoute('AI协同空间'), {
  key: 'ai-collaboration',
  productName: 'AI协同空间',
  projectId: '2168196',
  projectName: 'AI采购协同空间',
  repo: 'enterprise-development/ai-native-flow-platform',
  branch: 'feature/20260606_29656382_init_project_1',
  inspectRepository: true,
  classificationPending: false,
  needsClarification: false,
});

const other = resolveProductRoute('供应链预测系统');
assert.equal(other.projectId, '2165415');
assert.equal(other.classificationPending, true);
assert.equal(other.inspectRepository, false);
assert.equal(other.needsClarification, false);

assert.equal(resolveProductRoute('').needsClarification, true);
assert.throws(() => resolveProductRoute('ALT 平台'), /ALT/);

assert.equal(classifyRequirementIntent('这个需求现在进展怎么样了？'), 'requirement_progress');
assert.equal(classifyRequirementIntent('帮我新建一个需求'), 'requirement_create');
assert.equal(classifyRequirementIntent('把 84886503 的描述更新一下'), 'requirement_update');
assert.equal(classifyRequirementIntent('今天天气怎么样'), 'none');

const body = buildRequirementBody({
  productName: 'WebAgent',
  title: '支持工作项回读',
  background: '当前写入后无法确认实际落库结果。',
  goals: ['创建或更新后自动回读', '失败时返回可定位原因'],
  requirements: [
    { name: '自动回读', detail: '写操作完成后按 ID 查询完整工作项并核验关键字段。', priority: 'P0' },
    { name: '错误反馈', detail: '认证、权限和参数错误必须明确反馈。', priority: 'P1' },
  ],
  codeEvidence: [{ path: 'src/a1-client.mjs', finding: 'A1 调用适配层。' }],
  acceptanceCriteria: ['返回真实工作项链接', '回读内容与提交内容一致'],
  risks: ['A1 字段配置可能因项目不同而变化'],
  openQuestions: ['默认负责人由需求池规则还是显式参数决定？'],
});

for (const heading of ['需求主体', '背景与现状', '目标', '需求清单', '需求详细描述', '代码定位与影响范围', '验收标准', '风险与约束', '待澄清项']) {
  assert.match(body, new RegExp(`## ${heading}`));
}
assert.match(body, /\| 序号 \| 需求 \| 详细描述 \| 优先级 \|/);
assert.match(body, /src\/a1-client\.mjs/);
assert.throws(() => buildRequirementBody({ productName: 'ALT', title: 'x' }), /ALT/);

console.log('a1-requirements tests passed');
