import assert from 'node:assert/strict';
import {
  buildWorkspaceSelectionPrompt,
  buildWorkspaceSelectionRetryQuestion,
  looksLikeSemanticWorkspaceSelectionReply,
  parseWorkspaceSelectionDecision,
  resolveWorkspaceSelection,
} from './multica-workspace-selection.mjs';

const workspaces = Array.from({ length: 6 }, (_, index) => ({
  id: `ws-${index + 1}`,
  name: index === 5 ? '北京AI流程管理特训营' : `测试空间${index + 1}`,
  slug: index === 5 ? 'beijing-ai-training' : `test-${index + 1}`,
  internalSecret: `secret-${index + 1}`,
}));

let aiCalls = 0;
const deterministic = await resolveWorkspaceSelection({
  response: '6',
  workspaces,
  runAi: async () => {
    aiCalls += 1;
    return '{"workspaceId":"ws-1","confidence":"high"}';
  },
});
assert.equal(deterministic.workspace?.id, 'ws-6');
assert.equal(deterministic.source, 'deterministic');
assert.equal(aiCalls, 0, '确定性选择命中后不能浪费 AI 调用');

const semantic = await resolveWorkspaceSelection({
  response: '最后那个',
  request: '创建一个 AI 特训营调研 Issue',
  history: '助手刚刚列出了 6 个空间',
  workspaces,
  runAi: async prompt => {
    assert.match(prompt, /最后那个/);
    return '{"workspaceId":"ws-6","confidence":"high","reason":"用户指向候选列表最后一项"}';
  },
});
assert.equal(semantic.workspace?.id, 'ws-6');
assert.equal(semantic.source, 'semantic');

const prompt = buildWorkspaceSelectionPrompt({
  response: '培训那个空间',
  request: '创建 Issue',
  history: '此前列出了空间',
  workspaces,
});
assert.match(prompt, /"index":6/);
assert.match(prompt, /北京AI流程管理特训营/);
assert.doesNotMatch(prompt, /internalSecret|secret-6/, '提示词只允许暴露候选白名单字段');

assert.equal(parseWorkspaceSelectionDecision(
  '{"workspaceId":"invented","confidence":"high"}',
  workspaces,
).workspace, null, 'AI 不能凭空制造空间 ID');
assert.equal(parseWorkspaceSelectionDecision(
  '{"workspaceId":"ws-6","confidence":"low"}',
  workspaces,
).workspace, null, '低置信度不能自动写入');
assert.equal(parseWorkspaceSelectionDecision('不是 JSON', workspaces).workspace, null);

const invented = await resolveWorkspaceSelection({
  response: '培训那个',
  workspaces,
  runAi: async () => '{"workspaceId":"ws-99","confidence":"high"}',
});
assert.equal(invented.workspace, null);
assert.equal(invented.reason, 'unknown_workspace');

const failed = await resolveWorkspaceSelection({
  response: '就放到刚才说的那边',
  workspaces,
  runAi: async () => { throw new Error('runtime unavailable'); },
});
assert.equal(failed.workspace, null);
assert.equal(failed.reason, 'ai_error');

assert.equal(looksLikeSemanticWorkspaceSelectionReply('最后那个'), true);
assert.equal(looksLikeSemanticWorkspaceSelectionReply('培训那个空间'), true);
assert.equal(looksLikeSemanticWorkspaceSelectionReply('就放到刚才说的那边'), true);
assert.equal(looksLikeSemanticWorkspaceSelectionReply('大家下午好'), false);

const retry = buildWorkspaceSelectionRetryQuestion(['workspace']);
assert.match(retry, /序号|完整.*名称/);
assert.doesNotMatch(retry, /测试空间|北京AI流程管理特训营/);

console.log('MULTICA_WORKSPACE_SELECTION_TEST_OK');
