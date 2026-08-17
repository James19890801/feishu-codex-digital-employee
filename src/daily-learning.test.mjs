import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDailyLearningPrompt,
  groupLearningConversations,
  isLearningPathAllowed,
  nextDailyLearningAt,
  normalizeLearningResult,
  redactLearningText,
  scanLearningFiles,
  scanSkillCatalog,
  shouldRunDailyLearning,
} from './daily-learning.mjs';

const learningMessages = [];
for (let index = 0; index < 1_100; index += 1) {
  learningMessages.push({
    channel: 'wechat',
    chatType: 'group',
    chatId: 'wechat:group:large-room@chatroom',
    senderId: `wechat:member-${index % 3}`,
    role: 'user',
    content: `大群消息-${index}`,
    createdAt: new Date(1_780_000_000_000 + index).toISOString(),
    groupName: '普通交流群',
  });
}
const cappedGroups = groupLearningConversations(learningMessages, {
  maxMessages: 1_000,
  maxPerConversation: 1_000,
});
assert.equal(cappedGroups.reduce((sum, group) => sum + group.messages.length, 0), 1_000);
assert.equal(cappedGroups[0].messages[0].content, '大群消息-100');
assert.equal(cappedGroups[0].messages.at(-1).content, '大群消息-1099');

const contested = [];
for (const [channel, chatId, senderId, groupName] of [
  ['feishu', 'oc_private_feishu_group', 'ou_private_feishu_member', '普通飞书群'],
  ['enterpriseChat', 'enterpriseChat:group:private-ding-group', 'enterpriseChat:private-member', '普通企业会话群'],
  ['wechat', 'wechat:group:private-wechat-room@chatroom', 'wechat:private-member', 'AI流程与组织变革交流群'],
]) {
  for (let index = 0; index < 20; index += 1) {
    contested.push({
      channel,
      chatType: 'group',
      chatId,
      senderId,
      role: 'user',
      content: `${channel}-message-${index}`,
      createdAt: new Date(1_780_100_000_000 + index).toISOString(),
      groupName,
    });
  }
}
const balancedGroups = groupLearningConversations(contested, {
  maxMessages: 18,
  maxPerConversation: 20,
});
assert.equal(balancedGroups.length, 3, 'every active conversation must retain context');
assert.equal(balancedGroups.reduce((sum, group) => sum + group.messages.length, 0), 18);
const balancedByChannel = Object.fromEntries(
  balancedGroups.map(group => [group.channel, group.messages.length]),
);
assert.equal(balancedByChannel.wechat > balancedByChannel.feishu, true);
assert.equal(balancedByChannel.wechat > balancedByChannel.enterpriseChat, true);
for (const group of balancedGroups) {
  assert.equal(group.messages.every((message, index, messages) => (
    index === 0 || message.at >= messages[index - 1].at
  )), true, 'messages must remain chronological inside each conversation');
}
const balancedJson = JSON.stringify(balancedGroups);
for (const secretIdentity of [
  'oc_private_feishu_group',
  'ou_private_feishu_member',
  'private-ding-group',
  'private-wechat-room',
  'private-member',
  'AI流程与组织变革交流群',
]) {
  assert.equal(balancedJson.includes(secretIdentity), false, 'raw identities must not leave grouping');
}

const beforeOne = new Date('2026-08-06T16:30:00.000Z');
assert.equal(
  nextDailyLearningAt(beforeOne).toISOString(),
  '2026-08-06T17:00:00.000Z',
  '00:30 in Shanghai must schedule the same-day 01:00 run',
);
const afterOne = new Date('2026-08-06T17:05:00.000Z');
assert.equal(
  nextDailyLearningAt(afterOne).toISOString(),
  '2026-08-07T17:00:00.000Z',
  'after the 01:00 run, schedule the next local day',
);
assert.equal(
  nextDailyLearningAt(new Date('2026-08-06T15:30:00.000Z'), 0).toISOString(),
  '2026-08-06T16:00:00.000Z',
  'an explicitly configured midnight schedule must not fall back to 01:00',
);
assert.equal(shouldRunDailyLearning({
  now: afterOne,
  lastCompletedDate: '2026-08-06',
}), true);
assert.equal(shouldRunDailyLearning({
  now: afterOne,
  lastCompletedDate: '2026-08-07',
}), false);

assert.equal(isLearningPathAllowed('/Users/example/Documents/plan.md'), true);
assert.equal(isLearningPathAllowed('/Users/example/Library/Keychains/login.keychain-db'), false);
assert.equal(isLearningPathAllowed('/Users/example/.ssh/id_ed25519'), false);
assert.equal(isLearningPathAllowed('/Users/example/project/.env'), false);
assert.equal(isLearningPathAllowed('/Users/example/project/node_modules/pkg/index.js'), false);

const redacted = redactLearningText([
  '联系 james@example.com 或 139-0000-0000。',
  'password=never-commit-this',
  'Bearer abcdefghijklmnopqrstuvwxyz',
  'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
  'sk-proj-abcdefghijklmnopqrstuvwxyz1234567890',
  '路径 /Users/example/Desktop/private-plan.md',
].join('\n'), { home: '/Users/example' });
assert.equal(redacted.includes('james@example.com'), false);
assert.equal(redacted.includes('139-0000-0000'), false);
assert.equal(redacted.includes('never-commit-this'), false);
assert.equal(redacted.includes('abcdefghijklmnopqrstuvwxyz'), false);
assert.equal(redacted.includes('ghp_'), false);
assert.equal(redacted.includes('sk-proj-'), false);
assert.equal(redacted.includes('/Users/example'), false);
assert.match(redacted, /\[REDACTED_/);

const normalized = normalizeLearningResult({
  summary: '今天复盘了消息与任务。',
  memoryRules: ['先读取上下文再回答', '不要重复发送'],
  lessons: [
    { category: 'error', title: '重复回复', lesson: '发送前检查幂等键。' },
    { category: 'task', title: '交付任务', lesson: '持续同步进度与附件。' },
    { category: 'skill', title: 'PDF skill', lesson: '需要 PDF 时再使用。' },
    { category: 'unknown', title: 'invalid', lesson: 'drop me' },
  ],
});
assert.equal(normalized.lessons.length, 3);
assert.deepEqual(normalized.counts, { tasks: 1, skills: 1, errors: 1 });
assert.equal(normalized.memory.includes('先读取上下文再回答'), true);

const prompt = buildDailyLearningPrompt({
  previousMemory: '旧规则：回复前读上下文。',
  conversations: [{ role: 'user', content: 'PDF 怎么还没交付？' }],
  audits: [{ event: 'inbound_failed_final', detail: { error: 'timeout' } }],
  files: [{ path: '~/Documents/plan.md', excerpt: '任务方案' }],
  skills: [{ name: 'pdf', description: 'Create and inspect PDFs' }],
});
assert.match(prompt, /只输出 JSON/);
assert.match(prompt, /旧规则/);
assert.match(prompt, /inbound_failed_final/);
assert.equal(prompt.includes('password='), false);

const groupedPrompt = buildDailyLearningPrompt({
  previousMemory: '旧规则',
  conversationGroups: balancedGroups,
  audits: [],
  files: [],
  skills: [],
});
const groupedEvidence = JSON.parse(groupedPrompt.split('脱敏学习证据：\n').at(-1));
assert.equal(groupedEvidence.conversationGroups.length, 3);
assert.equal(
  groupedEvidence.conversationGroups.reduce((sum, group) => sum + group.messages.length, 0),
  18,
);
assert.deepEqual(
  new Set(groupedEvidence.conversationGroups.map(group => group.channel)),
  new Set(['feishu', 'enterpriseChat', 'wechat']),
);
assert.equal(groupedEvidence.conversationGroups.every(group => (
  group.messages.every(message => message.speaker)
)), true, 'grouped prompts must preserve anonymous speaker continuity');
for (const secretIdentity of [
  'oc_private_feishu_group',
  'ou_private_feishu_member',
  'private-ding-group',
  'private-wechat-room',
  'private-member',
  'AI流程与组织变革交流群',
]) {
  assert.equal(groupedPrompt.includes(secretIdentity), false);
}

const thousandMessagePrompt = buildDailyLearningPrompt({
  conversationGroups: cappedGroups,
});
const thousandMessageEvidence = JSON.parse(
  thousandMessagePrompt.split('脱敏学习证据：\n').at(-1),
);
assert.equal(thousandMessageEvidence.conversationGroups[0].messages.length, 1_000);
assert.equal(thousandMessagePrompt.length < 500_000, true, '1000-message prompt must stay bounded');

const boundedPrompt = buildDailyLearningPrompt({
  previousMemory: 'm'.repeat(100_000),
  conversations: Array.from({ length: 1000 }, () => ({ role: 'user', content: 'c'.repeat(3000) })),
  audits: Array.from({ length: 1000 }, () => ({ event: 'error', detail: { error: 'a'.repeat(3000) } })),
  files: Array.from({ length: 1000 }, (_, index) => ({ path: `~/file-${index}.md`, excerpt: 'f'.repeat(3000) })),
  skills: Array.from({ length: 1000 }, (_, index) => ({ name: `skill-${index}`, description: 's'.repeat(1000) })),
});
assert.equal(boundedPrompt.length < 200_000, true, 'daily learning prompt must stay bounded');

const scanRoot = await mkdtemp(join(tmpdir(), 'aipro-learning-'));
try {
  await mkdir(join(scanRoot, 'project', 'node_modules'), { recursive: true });
  await mkdir(join(scanRoot, 'nested'), { recursive: true });
  await mkdir(join(scanRoot, 'skills', 'pdf'), { recursive: true });
  await writeFile(join(scanRoot, 'plan.md'), '发布任务需要同步状态。');
  await writeFile(join(scanRoot, '.env'), 'SECRET=must-not-leak');
  await writeFile(join(scanRoot, 'project', 'node_modules', 'ignored.js'), 'ignored');
  await writeFile(join(scanRoot, 'nested', 'bounded.md'), 'must be skipped by the directory budget');
  await writeFile(join(scanRoot, 'skills', 'pdf', 'SKILL.md'), [
    '---',
    'name: pdf',
    'description: Create and inspect PDFs',
    '---',
    'PDF instructions',
  ].join('\n'));
  const files = await scanLearningFiles({ roots: [scanRoot], sinceMs: 0, maxFiles: 20 });
  assert.equal(files.some(item => item.path.endsWith('plan.md')), true);
  assert.equal(files.some(item => item.path.endsWith('.env')), false);
  assert.equal(files.some(item => item.path.includes('node_modules')), false);
  const boundedFiles = await scanLearningFiles({
    roots: [scanRoot], sinceMs: 0, maxFiles: 20, maxDirectories: 1, maxDurationMs: 5_000,
  });
  assert.equal(
    boundedFiles.some(item => item.path.endsWith('bounded.md')),
    false,
    'the scanner must honor its directory budget',
  );
  const skills = await scanSkillCatalog({ roots: [join(scanRoot, 'skills')] });
  assert.deepEqual(skills, [{ name: 'pdf', description: 'Create and inspect PDFs' }]);
} finally {
  await rm(scanRoot, { recursive: true, force: true });
}

console.log('DAILY_LEARNING_TEST_OK');
