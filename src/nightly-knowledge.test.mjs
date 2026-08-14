import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDwsEnv,
  buildDwsSourceCommands,
  collectCodexSessions,
  isKnowledgeRecordSafe,
  redactKnowledgeText,
  renderDailyWiki,
  runNightlyKnowledgeSync,
} from './nightly-knowledge.mjs';

const env = buildDwsEnv({
  baseEnv: { PATH: '/usr/bin', DWS_CHANNEL: 'wrong' },
  channel: 'channel-1',
});
assert.equal(env.DWS_CHANNEL, 'channel-1');
assert.equal(env.PATH, '/usr/bin');

const commands = buildDwsSourceCommands({
  profile: 'corp:user',
  startMs: 1000,
  endMs: 2000,
  cursor: '0',
});
assert.deepEqual(commands.chat.slice(0, 3), ['chat', 'message', 'list-all']);
assert.ok(commands.chat.includes('--profile'));
assert.ok(commands.chat.includes('corp:user'));
assert.ok(commands.chat.includes('--format'));
assert.deepEqual(commands.minutes.slice(0, 3), ['minutes', 'list', 'all']);
assert.ok(commands.minutes.includes('30'));
assert.ok(commands.documents.includes('recent'));
assert.equal(commands.documents[0], 'drive');

assert.equal(
  redactKnowledgeText('token=sk-secret Bearer abc.def.ghi 手机 13812345678'),
  'token=[REDACTED] Bearer [REDACTED] 手机 138****5678',
);
assert.equal(isKnowledgeRecordSafe({ source: 'artifacts', locator: 'file:/tmp/config.local.json' }), false);
assert.equal(isKnowledgeRecordSafe({ source: 'artifacts', locator: 'file:/tmp/design.md' }), true);

const markdown = renderDailyWiki({
  date: '2026-08-04',
  generatedAt: '2026-08-04T10:00:00.000Z',
  sources: {
    chat: { status: 'ok', records: [{ id: 'm1', title: '群聊', text: '确认方案', locator: 'dingtalk:chat:m1' }] },
    minutes: { status: 'unread', error: 'not_authenticated', records: [] },
  },
});
assert.match(markdown, /# AIPR0S 知识日报 · 2026-08-04/);
assert.match(markdown, /钉钉聊天.*已读取/s);
assert.match(markdown, /AI 听记.*未读取/s);
assert.match(markdown, /确认方案/);
assert.match(markdown, /dingtalk:chat:m1/);

const codexHome = await mkdtemp(join(tmpdir(), 'aipros-codex-'));
const sessionDir = join(codexHome, 'sessions', '2026', '08', '04');
await mkdir(sessionDir, { recursive: true });
const sessionPath = join(sessionDir, 'rollout-test.jsonl');
await writeFile(sessionPath, [
  JSON.stringify({ type: 'session_meta', timestamp: '2026-08-04T09:00:00Z', payload: { id: 'thread-1', cwd: '/workspace' } }),
  JSON.stringify({ type: 'response_item', timestamp: '2026-08-04T09:01:00Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '实现夜间同步' }] } }),
  JSON.stringify({ type: 'response_item', timestamp: '2026-08-04T09:02:00Z', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已经完成 token=sk-nope' }] } }),
].join('\n'));
const codex = await collectCodexSessions({ codexHome, sinceMs: 0, maxFiles: 10 });
assert.equal(codex.records.length, 1);
assert.equal(codex.records[0].id, 'thread-1');
assert.match(codex.records[0].text, /实现夜间同步/);
assert.doesNotMatch(codex.records[0].text, /sk-nope/);

const wikiRoot = await mkdtemp(join(tmpdir(), 'aipros-wiki-'));
let chatCalls = 0;
const fakeCollectors = {
  chat: async () => {
    chatCalls += 1;
    return { status: 'ok', cursor: 'cursor-2', records: [{ id: 'same', title: '私聊', text: '一个结论', locator: 'dingtalk:message:same' }] };
  },
  minutes: async () => ({ status: 'unread', error: 'permission denied', records: [] }),
  documents: async () => ({ status: 'ok', cursor: 'docs-2', records: [] }),
  codex: async () => ({ status: 'ok', cursor: 'codex-2', records: [] }),
  artifacts: async () => ({ status: 'ok', cursor: 'artifacts-2', records: [] }),
};
const clock = () => new Date('2026-08-04T10:00:00.000Z');
const first = await runNightlyKnowledgeSync({ wikiRoot, collectors: fakeCollectors, clock });
const second = await runNightlyKnowledgeSync({ wikiRoot, collectors: fakeCollectors, clock });
assert.equal(chatCalls, 2);
assert.equal(first.newRecordCount, 1);
assert.equal(second.newRecordCount, 0);
const state = JSON.parse(await readFile(join(wikiRoot, 'state.json'), 'utf8'));
assert.equal(state.sources.chat.cursor, 'cursor-2');
assert.equal(state.sources.minutes?.cursor, undefined, 'failed sources must not advance their cursor');
const daily = await readFile(join(wikiRoot, 'daily', '2026-08-04.md'), 'utf8');
assert.equal((daily.match(/一个结论/g) || []).length, 1);

await writeFile(join(wikiRoot, '.sync.lock'), '999999\n');
const recovered = await runNightlyKnowledgeSync({ wikiRoot, collectors: fakeCollectors, clock });
assert.equal(recovered.newRecordCount, 0, 'a lock owned by a dead process must be recovered');

console.log('NIGHTLY_KNOWLEDGE_TEST_OK');
