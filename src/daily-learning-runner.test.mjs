import assert from 'node:assert/strict';
import { DailyLearningEngine } from './daily-learning.mjs';

const calls = [];
let scannedRoots = [];
let conversationsEnriched = false;
const stages = [];
const values = new Map([
  ['learning:memory', '旧记忆'],
]);
const state = {
  get(scope, key, fallback) { return values.get(`${scope}:${key}`) ?? fallback; },
  set(scope, key, value) {
    values.set(`${scope}:${key}`, value);
    if (scope === 'learning' && key === 'status') stages.push(value.stage);
  },
  unset(scope, key) { values.delete(`${scope}:${key}`); },
  learningEvidence() {
    return {
      conversations: [
        {
          channel: 'feishu', chatType: 'group', chatId: 'oc_private_feishu',
          senderId: 'ou_private_feishu', role: 'user',
          content: 'password=bad PDF 为什么没交付？', createdAt: '2026-08-06T14:00:00.000Z',
        },
        {
          channel: 'enterpriseChat', chatType: 'group', chatId: 'enterpriseChat:group:private-ding',
          senderId: 'enterpriseChat:private-sender', role: 'user',
          content: '企业会话流程复盘', createdAt: '2026-08-06T14:00:01.000Z',
        },
        {
          channel: 'wechat', chatType: 'group', chatId: 'wechat:group:private-room@chatroom',
          senderId: 'wechat:private-sender', role: 'user',
          content: '微信组织变革讨论', createdAt: '2026-08-06T14:00:02.000Z',
        },
      ],
      audits: [{ event: 'inbound_failed_final', detail: { error: 'timeout' } }],
    };
  },
  startLearningRun(run) { calls.push(['start', run]); },
  completeLearningRun(id, result) { calls.push(['complete', id, result]); },
  failLearningRun(id, error) { calls.push(['fail', id, String(error)]); },
  audit(event, payload) { calls.push(['audit', event, payload]); },
};

const engine = new DailyLearningEngine({
  state,
  home: '/Users/example',
  workdir: '/Users/example/Applications/AIPRO',
  scanFiles: async options => {
    scannedRoots = options.roots;
    return [{ path: '~/Documents/plan.md', excerpt: '交付时同步状态' }];
  },
  scanSkills: async () => [{ name: 'pdf', description: 'Create PDFs' }],
  enrichConversations: async conversations => {
    conversationsEnriched = true;
    return conversations.map(conversation => conversation.channel === 'wechat'
      ? { ...conversation, groupName: '专业流程交流群' }
      : conversation);
  },
  runAi: async prompt => {
    assert.equal(conversationsEnriched, true, 'conversation context must be enriched before grouping');
    assert.equal(prompt.includes('password=bad'), false);
    for (const rawIdentity of ['oc_private_feishu', 'private-ding', 'private-room', 'private-sender']) {
      assert.equal(prompt.includes(rawIdentity), false);
    }
    const evidence = JSON.parse(prompt.split('脱敏学习证据：\n').at(-1));
    assert.deepEqual(
      new Set(evidence.conversationGroups.map(group => group.channel)),
      new Set(['feishu', 'enterpriseChat', 'wechat']),
    );
    return { text: JSON.stringify({
      summary: '完成今日复盘。',
      memoryRules: ['交付后主动同步状态'],
      lessons: [
        { category: 'error', title: '交付遗漏', lesson: '检查最终附件。' },
        { category: 'task', title: '任务闭环', lesson: '同步全过程状态。' },
        { category: 'skill', title: 'PDF', lesson: '需要 PDF 时调用该 Skill。' },
      ],
    }) };
  },
});

const result = await engine.execute({
  now: new Date('2026-08-06T17:00:00.000Z'),
  reason: 'scheduled',
});
assert.equal(result.learningDate, '2026-08-07');
assert.deepEqual(result.counts, { tasks: 1, skills: 1, errors: 1 });
assert.equal(calls[0][0], 'start');
const completed = calls.find(item => item[0] === 'complete');
assert.equal(completed[2].filesScanned, 1);
assert.equal(completed[2].chatsReviewed, 3);
assert.equal(completed[2].items.length, 3);
assert.equal(calls.some(item => item[0] === 'audit' && item[1] === 'daily_learning_completed'), true);
const completedAudit = calls.find(item => item[0] === 'audit' && item[1] === 'daily_learning_completed');
assert.equal(completedAudit[2].detail.conversationGroups, 3);
assert.deepEqual(completedAudit[2].detail.sourceChannels.sort(), ['enterpriseChat', 'feishu', 'wechat']);
assert.equal(scannedRoots.includes('/Users/example'), false, 'the scanner must not traverse the entire home tree');
assert.deepEqual(scannedRoots, ['/Users/example/Applications/AIPRO']);
assert.deepEqual(stages.filter(Boolean), ['history', 'files', 'skills', 'analyzing']);

const failingCalls = [];
const failingEngine = new DailyLearningEngine({
  state: {
    ...state,
    startLearningRun(run) { failingCalls.push(['start', run]); },
    failLearningRun(id, error) { failingCalls.push(['fail', id, String(error)]); },
    audit(event) { failingCalls.push(['audit', event]); },
  },
  home: '/Users/example',
  workdir: '/tmp/aipro',
  scanFiles: async () => [],
  scanSkills: async () => [],
  runAi: async () => { throw new Error('runtime unavailable'); },
});
await assert.rejects(
  failingEngine.execute({ now: new Date('2026-08-06T17:00:00.000Z') }),
  /runtime unavailable/,
);
assert.equal(failingCalls.some(item => item[0] === 'fail'), true);
assert.equal(failingCalls.some(item => item[0] === 'audit' && item[1] === 'daily_learning_failed'), true);

console.log('DAILY_LEARNING_RUNNER_TEST_OK');
