import assert from 'node:assert/strict';
import {
  buildMulticaCreateIntentPrompt,
  looksLikePotentialMulticaCreate,
  parseMulticaCreateIntentDecision,
  resolveMulticaCreateIntent,
} from './multica-create-intent.mjs';

let calls = 0;
const explicit = await resolveMulticaCreateIntent({
  text: '帮我创建一个 Multica Issue，调研 AI 培训价格',
  channel: 'dingtalk',
  runAi: async () => {
    calls += 1;
    return '{"isCreateIssue":false,"confidence":"high"}';
  },
});
assert.equal(explicit.matched, true);
assert.equal(explicit.source, 'deterministic');
assert.equal(calls, 0, '明确创建意图不能浪费 AI 调用');

const spoken = await resolveMulticaCreateIntent({
  text: '你要去创建个医企，调研一下 AI 加流程管理在中国培训，哪个机构最厉害',
  channel: 'dingtalk',
  history: '用户正在讨论 Multica 任务',
  runAi: async prompt => {
    assert.match(prompt, /创建个医企/);
    assert.match(prompt, /dingtalk/);
    return '{"isCreateIssue":true,"confidence":"high","reason":"医企是 Issue 的语音同音转写"}';
  },
});
assert.equal(spoken.matched, true);
assert.equal(spoken.source, 'semantic');

assert.equal(looksLikePotentialMulticaCreate('创建个医企，调研培训机构'), true);
assert.equal(looksLikePotentialMulticaCreate('新建一个调研任务，比较培训机构'), true);
assert.equal(looksLikePotentialMulticaCreate('大家下午好'), false);

const prompt = buildMulticaCreateIntentPrompt({
  text: '创建个医企，做市场调研',
  channel: 'dingtalk',
  history: '最近提到 Multica',
});
assert.match(prompt, /日程、会议、待办、文档/);
assert.doesNotMatch(prompt, /undefined/);

assert.deepEqual(
  parseMulticaCreateIntentDecision('{"isCreateIssue":true,"confidence":"low"}'),
  { matched: false, confidence: 'low', reason: 'low_confidence' },
);
assert.deepEqual(
  parseMulticaCreateIntentDecision('not json'),
  { matched: false, confidence: 'low', reason: 'invalid_json' },
);

const unrelated = await resolveMulticaCreateIntent({
  text: '大家下午好',
  channel: 'dingtalk',
  runAi: async () => {
    calls += 1;
    return '{"isCreateIssue":true,"confidence":"high"}';
  },
});
assert.equal(unrelated.matched, false);
assert.equal(unrelated.reason, 'not_candidate');

const failed = await resolveMulticaCreateIntent({
  text: '创建个医企，调研培训机构',
  channel: 'dingtalk',
  runAi: async () => { throw new Error('runtime unavailable'); },
});
assert.equal(failed.matched, false);
assert.equal(failed.reason, 'ai_error');

console.log('MULTICA_CREATE_INTENT_TEST_OK');
