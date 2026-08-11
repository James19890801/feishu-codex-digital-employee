#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import {
  buildDwsEnv,
  buildDwsSourceCommands,
  collectCodexSessions,
  redactKnowledgeText,
  runNightlyKnowledgeSync,
} from '../src/nightly-knowledge.mjs';

const execFileAsync = promisify(execFile);
const WORKDIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_WIKI_ROOT = join(WORKDIR, 'data', 'knowledge-wiki');
const DEFAULT_DWS = join(homedir(), '.npm-global', 'bin', 'dws');
const SOURCE_ORDER = ['chat', 'minutes', 'documents', 'codex', 'artifacts'];

function parseArgs(argv) {
  const args = { dryRun: false, publish: false, lookbackDays: 30, maxPages: 10 };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--dry-run') args.dryRun = true;
    else if (value === '--publish') args.publish = true;
    else if (value === '--no-publish') args.publish = false;
    else if (value === '--lookback-days') args.lookbackDays = Number(argv[++i]);
    else if (value === '--max-pages') args.maxPages = Number(argv[++i]);
    else if (value === '--wiki-root') args.wikiRoot = resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  return args;
}

function assertStandaloneDwsPath(path) {
  const value = String(path || '');
  if (!value.endsWith('/.npm-global/bin/dws') || value.includes('/.real/') || /wukong/iu.test(value)) {
    throw new Error(`Nightly sync requires standalone DWS Channel CLI, got: ${value || '(empty)'}`);
  }
}

function parseDwsJson(stdout) {
  const text = String(stdout || '').trim();
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines.slice(i).join('\n')); } catch {}
  }
  throw new Error('DWS returned non-JSON output');
}

function unwrap(payload) {
  if (payload?.success === false || payload?.error) {
    throw new Error(payload?.error?.message || payload?.message || 'DWS request failed');
  }
  return payload?.result ?? payload;
}

function firstValue(object, keys, fallback = '') {
  for (const key of keys) {
    const value = object?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return fallback;
}

function arrayValue(object, keys) {
  for (const key of keys) if (Array.isArray(object?.[key])) return object[key];
  return [];
}

async function runDwsFactory({ dwsBin, profile, channel }) {
  assertStandaloneDwsPath(dwsBin);
  const env = buildDwsEnv({ baseEnv: process.env, channel });
  return async args => {
    const withProfile = args.includes('--profile') ? args : [...args, '--profile', profile];
    const finalArgs = withProfile.includes('--format') ? withProfile : [...withProfile, '--format', 'json'];
    const { stdout } = await execFileAsync(dwsBin, finalArgs, {
      cwd: WORKDIR, env, timeout: 120000, maxBuffer: 16 * 1024 * 1024,
    });
    return parseDwsJson(stdout);
  };
}

function decodeWindow(cursor, nowMs, lookbackDays) {
  try {
    const parsed = JSON.parse(cursor || '');
    if (Number.isFinite(parsed.startMs) && Number.isFinite(parsed.endMs)) return parsed;
  } catch {}
  return { startMs: nowMs - lookbackDays * 86400000, endMs: nowMs, cursor: '0' };
}

function encodeWindow({ startMs, endMs, cursor }) {
  return JSON.stringify({ startMs, endMs, cursor: String(cursor || '0') });
}

function chatRecords(result) {
  const conversations = arrayValue(result, ['conversationMessagesList', 'conversations', 'items']);
  return conversations.flatMap(conversation => arrayValue(conversation, ['messages', 'messageList']).map(message => ({
    id: String(firstValue(message, ['openMessageId', 'messageId', 'id'])),
    title: `${conversation.title || '钉钉会话'} · ${message.sender || '未知发送者'}`,
    text: firstValue(message, ['content', 'text', 'message']),
    locator: `dingtalk:message:${firstValue(message, ['openMessageId', 'messageId', 'id'])}`,
    metadata: {
      conversationId: firstValue(conversation, ['openConversationId', 'conversationId']),
      sender: message.sender || '', createTime: firstValue(message, ['createTime', 'createdAt']),
    },
  })).filter(record => record.id && record.text));
}

async function collectDwsChat({ runDws, profile, state, now, lookbackDays, maxPages }) {
  let window = decodeWindow(state.cursor, now.getTime(), lookbackDays);
  const records = [];
  let page = 0;
  while (page < maxPages) {
    const result = unwrap(await runDws(buildDwsSourceCommands({ profile, ...window }).chat));
    records.push(...chatRecords(result));
    page += 1;
    if (!result.hasMore) {
      window = { startMs: window.endMs, endMs: now.getTime(), cursor: '0' };
      break;
    }
    window.cursor = firstValue(result, ['nextCursor'], window.cursor);
  }
  return { status: 'ok', cursor: encodeWindow(window), records };
}

function minutesArtifactResult(value) {
  return value?.result ?? value ?? {};
}

function minutesActionText(action) {
  if (typeof action !== 'string') return firstValue(action, ['value', 'title', 'content', 'text']);
  try { return firstValue(JSON.parse(action), ['value', 'title', 'content', 'text'], action); }
  catch { return action; }
}

async function collectDwsMinutes({ runDws, profile, state }) {
  const args = ['minutes', '+list-all', '--limit', '5'];
  if (state.cursor) args.push('--cursor', state.cursor);
  const result = unwrap(await runDws([...args, '--profile', profile, '--format', 'json']));
  const items = arrayValue(result, ['minutes', 'items', 'list']);
  const records = [];
  for (const item of items.slice(0, 5)) {
    const id = firstValue(item, ['taskUuid', 'id', 'minutesId', 'recordId', 'objectId']);
    if (!id) continue;
    let detail = item;
    try {
      detail = unwrap(await runDws(['minutes', '+detail', '--id', String(id), '--artifacts', 'basic,summary,keywords,transcript,todos']));
    } catch (error) { detail = { ...item, detailError: error.message }; }
    const basic = minutesArtifactResult(detail.basic);
    const summary = minutesArtifactResult(detail.summary);
    const keywords = minutesArtifactResult(detail.keywords);
    const transcript = minutesArtifactResult(detail.transcript);
    const todos = minutesArtifactResult(detail.todos);
    const keywordList = Array.isArray(keywords) ? keywords : arrayValue(keywords, ['keywords', 'items', 'list']);
    const paragraphs = arrayValue(transcript, ['paragraphList', 'paragraphs', 'items', 'list']);
    const actions = arrayValue(todos, ['actions', 'todos', 'items', 'list']).map(minutesActionText).filter(Boolean);
    const text = [
      firstValue(summary, ['fullSummary', 'summary', 'content', 'text'], firstValue(detail, ['meetingSummary', 'abstract'])),
      keywordList.length ? `关键词：${keywordList.join('、')}` : '',
      actions.length ? `待办：${actions.join('；')}` : '',
      paragraphs.map(paragraph => {
        const speaker = firstValue(paragraph, ['nickName', 'speakerName']) || firstValue(paragraph.speakerDisplay, ['nickName', 'name'], '发言人');
        const content = firstValue(paragraph, ['paragraph', 'content', 'text']);
        return content ? `${speaker}：${content}` : '';
      }).filter(Boolean).join('\n'),
      detail.detailError ? `详情未读取：${detail.detailError}` : '',
    ].filter(Boolean).join('\n\n');
    records.push({
      id: String(id),
      title: firstValue(basic, ['title', 'subject', 'name'], firstValue(item, ['title', 'subject', 'name'], `AI 听记 ${id}`)),
      text: text || JSON.stringify(detail).slice(0, 12000),
      locator: firstValue(basic, ['url'], firstValue(item, ['url'], `dingtalk:minutes:${id}`)),
    });
  }
  return { status: 'ok', cursor: firstValue(result, ['nextToken', 'nextCursor'], ''), records };
}

async function collectDwsDocuments({ runDws, profile, state }) {
  const args = ['drive', 'recent', '--operate-type', '0,1', '--limit', '5'];
  if (state.cursor) args.push('--cursor', state.cursor);
  const result = unwrap(await runDws([...args, '--profile', profile, '--format', 'json']));
  const items = arrayValue(result, ['recentItems', 'items', 'documents']);
  const records = [];
  for (const item of items) {
    const node = firstValue(item, ['nodeId', 'fileId', 'dentryUuid', 'id']);
    if (!node) continue;
    let body = '';
    const extension = String(firstValue(item, ['extension', 'ext'])).toLowerCase();
    if (!extension || extension === 'adoc') {
      try {
        const read = unwrap(await runDws(['doc', 'read', '--node', String(node)]));
        body = firstValue(read, ['markdown', 'content', 'text']);
      } catch (error) { body = `正文未读取：${error.message}`; }
    }
    records.push({
      id: String(node), title: firstValue(item, ['name', 'title'], `钉钉文档 ${node}`),
      text: body || `文档类型：${extension || firstValue(item, ['contentType'], '未知')}；更新时间：${firstValue(item, ['updateTime', 'accessTime'], '未知')}`,
      locator: firstValue(item, ['docUrl', 'url'], `dingtalk:doc:${node}`),
    });
  }
  return { status: 'ok', cursor: firstValue(result, ['nextCursor'], ''), records };
}

async function walkArtifacts(root, sinceMs, output = []) {
  const excluded = new Set(['.git', 'node_modules', 'data', 'dist', 'build', '.next']);
  const forbiddenFiles = /^(?:config\.local(?:\..*)?|\.env(?:\..*)?|auth(?:entication)?(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?)$/iu;
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return output; }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || excluded.has(entry.name) || forbiddenFiles.test(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) await walkArtifacts(path, sinceMs, output);
    else if (entry.isFile() && /\.(?:md|txt|json|html|csv)$/iu.test(entry.name)) {
      const info = await stat(path);
      if (info.mtimeMs > sinceMs && info.size <= 2 * 1024 * 1024) output.push({ path, info });
    }
  }
  return output;
}

async function collectArtifacts({ state, now, roots }) {
  const sinceMs = Number(state.cursor || now.getTime() - 30 * 86400000);
  const files = [];
  for (const root of roots) await walkArtifacts(root, sinceMs, files);
  files.sort((a, b) => a.info.mtimeMs - b.info.mtimeMs);
  const records = [];
  const processed = files.slice(0, 20);
  for (const file of processed) {
    const text = redactKnowledgeText((await readFile(file.path, 'utf8')).slice(0, 20000));
    if (!text) continue;
    records.push({
      id: createHash('sha256').update(file.path).digest('hex').slice(0, 16), title: file.path.split('/').pop(), text,
      locator: `file:${file.path}`, metadata: { mtimeMs: file.info.mtimeMs },
    });
  }
  const cursor = processed.length ? Math.max(...processed.map(file => file.info.mtimeMs)) : sinceMs;
  return { status: 'ok', cursor: String(cursor), records };
}

function findWorkspaceId(payload, name) {
  const data = unwrap(payload);
  const spaces = arrayValue(data, ['wikiSpaces', 'spaces', 'items', 'list']);
  const match = spaces.find(space => firstValue(space, ['name', 'title', 'spaceName']) === name) || spaces[0];
  return firstValue(match || data, ['workspaceId', 'spaceId', 'id', 'encryptedId']);
}

function findNodeId(payload, name) {
  const data = unwrap(payload);
  const items = arrayValue(data, ['nodes', 'items', 'documents', 'list', 'searchResults']);
  const match = items.find(item => firstValue(item, ['name', 'title']) === name);
  if (items.length > 0 && !match) return '';
  return firstValue(match || data, ['nodeId', 'fileId', 'id', 'dentryUuid']);
}

export { collectDwsMinutes, findNodeId };

function buildRemoteWikiDigest(result) {
  const records = result.index.records.filter(record => record.date === result.date).slice(-100);
  const lines = [
    `# AIPR0S 知识日报 · ${result.date}`,
    '',
    `生成时间：${result.generatedAt}`,
    '',
    '## 来源状态',
    '',
  ];
  for (const source of SOURCE_ORDER) {
    const status = result.sources[source];
    if (!status) continue;
    lines.push(status.status === 'ok'
      ? `- ${source}：已读取（${status.records?.length || 0} 条）`
      : `- ${source}：未读取（${redactKnowledgeText(status.error || '未知错误')}）`);
  }
  lines.push('', '## 知识索引', '');
  if (!records.length) lines.push('本次没有新增知识。');
  for (const record of records) {
    const excerpt = String(record.text || '').replace(/\s+/gu, ' ').slice(0, 240);
    lines.push(`### ${record.title}`, '', excerpt || '（仅有元数据）');
    if (record.locator) lines.push('', `来源：${record.locator}`);
    lines.push('');
  }
  lines.push('> 完整正文保存在账号本机的 owner 私有知识库中，数字人按需检索，不在钉钉镜像中复制全部原文。');
  return `${lines.join('\n').trim()}\n`;
}

async function publishWiki({ runDws, result, wikiRoot }) {
  const spaceName = 'AIPR0S 数字人知识库';
  const remotePath = join(wikiRoot, 'remote.json');
  let remote = {};
  try { remote = JSON.parse(await readFile(remotePath, 'utf8')); } catch {}
  let workspaceId = remote.workspaceId;
  if (!workspaceId) workspaceId = findWorkspaceId(await runDws(['wiki', 'space', 'search', '--query', spaceName, '--limit', '10']), spaceName);
  if (!workspaceId) workspaceId = findWorkspaceId(await runDws(['wiki', 'space', 'create', '--name', spaceName, '--desc', 'AIPR0S 每晚自动更新的 owner 私有知识库']), spaceName);
  if (!workspaceId) throw new Error('DingTalk Wiki space creation returned no workspaceId');
  const nodeName = `知识日报 ${result.date}`;
  let nodeId = remote.nodes?.[result.date];
  if (!nodeId) nodeId = findNodeId(await runDws(['wiki', 'node', 'search', '--workspace', workspaceId, '--query', nodeName, '--extensions', 'adoc', '--limit', '10']), nodeName);
  if (!nodeId) nodeId = findNodeId(await runDws(['wiki', 'node', 'create', '--workspace', workspaceId, '--name', nodeName, '--type', 'adoc']), nodeName);
  if (!nodeId) throw new Error('DingTalk Wiki node creation returned no nodeId');
  const digest = buildRemoteWikiDigest(result);
  const hash = createHash('sha256').update(digest).digest('hex');
  if (remote.published?.[result.date] !== hash) {
    const contentPath = join(wikiRoot, '.publish.md');
    await writeFile(contentPath, `\n\n<!-- aipros-sync:${hash} -->\n${digest}`, { mode: 0o600 });
    await runDws(['doc', 'update', '--node', nodeId, '--content-file', contentPath, '--mode', 'overwrite', '--yes']);
    remote.published = { ...(remote.published || {}), [result.date]: hash };
  }
  remote.workspaceId = workspaceId;
  remote.nodes = { ...(remote.nodes || {}), [result.date]: nodeId };
  await writeFile(remotePath, `${JSON.stringify(remote, null, 2)}\n`, { mode: 0o600 });
  return { workspaceId, nodeId, hash };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const config = JSON.parse(await readFile(join(WORKDIR, 'config.local.json'), 'utf8'));
  const dwsBin = config.dingtalkBin || DEFAULT_DWS;
  const profile = config.dingtalkProfile;
  const channel = config.dingtalkChannel;
  if (!profile || !channel) throw new Error('dingtalkProfile and dingtalkChannel are required');
  const runDws = await runDwsFactory({ dwsBin, profile, channel });
  const wikiRoot = options.wikiRoot || DEFAULT_WIKI_ROOT;
  const collectors = {
    chat: context => collectDwsChat({ ...context, runDws, profile, lookbackDays: options.lookbackDays, maxPages: options.maxPages }),
    minutes: context => collectDwsMinutes({ ...context, runDws, profile }),
    documents: context => collectDwsDocuments({ ...context, runDws, profile }),
    codex: ({ state }) => collectCodexSessions({ codexHome: process.env.CODEX_HOME || join(homedir(), '.codex'), sinceMs: Number(state.cursor || 0), maxFiles: 20 }),
    artifacts: context => collectArtifacts({ ...context, roots: [WORKDIR] }),
  };
  const result = await runNightlyKnowledgeSync({ wikiRoot, collectors, dryRun: options.dryRun });
  const remote = options.publish && !options.dryRun ? await publishWiki({ runDws, result, wikiRoot }) : null;
  const report = {
    success: true, date: result.date, dryRun: options.dryRun, newRecordCount: result.newRecordCount,
    sources: Object.fromEntries(SOURCE_ORDER.filter(source => result.sources[source]).map(source => [source, {
      status: result.sources[source].status, count: result.sources[source].records?.length || 0, error: result.sources[source].error || undefined,
    }])),
    localWiki: wikiRoot, remote,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`${JSON.stringify({ success: false, error: redactKnowledgeText(error.message) })}\n`);
    process.exitCode = 1;
  });
}
