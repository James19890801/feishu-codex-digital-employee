import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDailyLearningPrompt,
  isLearningPathAllowed,
  nextDailyLearningAt,
  normalizeLearningResult,
  redactLearningText,
  scanLearningFiles,
  scanSkillCatalog,
  shouldRunDailyLearning,
} from './daily-learning.mjs';

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
